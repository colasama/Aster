use std::io::{self, Read, Write};
use std::process::ExitStatus;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use crate::CancellationToken;
use crate::ffmpeg::{BoundedRead, read_bounded, terminate};

use super::spec::FrameMessage;
use super::{ExportError, ExportFrameReceiver};

const FRAME_POLL_INTERVAL: Duration = Duration::from_millis(5);

pub(super) type Reader = thread::JoinHandle<io::Result<BoundedRead>>;

pub(super) fn spawn_reader(reader: impl Read + Send + 'static, limit: usize) -> Reader {
    thread::spawn(move || read_bounded(reader, limit))
}

pub(super) fn join_reader(reader: Reader) -> Result<BoundedRead, ExportError> {
    reader
        .join()
        .map_err(|_| process_io("process output reader panicked"))?
        .map_err(process_io)
}

pub(super) fn write_frames(
    mut stdin: impl Write,
    frames: ExportFrameReceiver,
    frame_bytes: usize,
    frame_count: u64,
    cancellation: &CancellationToken,
) -> Result<(), ExportError> {
    if frame_count == 0 {
        return Err(ExportError::InvalidRequest(
            "frame count must be positive".into(),
        ));
    }
    for index in 0..frame_count - 1 {
        let frame = receive_frame(&frames, index, frame_count, cancellation)?;
        validate_frame_size(&frame, index, frame_bytes)?;
        stdin.write_all(&frame).map_err(process_io)?;
    }

    // Hold the final frame until the producer closes the protocol with Finished.
    // FFmpeg therefore cannot satisfy `-frames:v N` and exit successfully while
    // a legitimate producer is about to send the finish marker.
    let final_index = frame_count - 1;
    let final_frame = receive_frame(&frames, final_index, frame_count, cancellation)?;
    validate_frame_size(&final_frame, final_index, frame_bytes)?;
    wait_for_finish(&frames, frame_count, cancellation)?;
    stdin.write_all(&final_frame).map_err(process_io)?;
    stdin.flush().map_err(process_io)
}

fn validate_frame_size(frame: &[u8], index: u64, expected: usize) -> Result<(), ExportError> {
    if frame.len() != expected {
        return Err(ExportError::InvalidFrameSize {
            index,
            expected,
            actual: frame.len(),
        });
    }
    Ok(())
}

fn receive_frame(
    frames: &ExportFrameReceiver,
    index: u64,
    frame_count: u64,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, ExportError> {
    loop {
        if cancellation.is_cancelled() {
            return Err(ExportError::Cancelled);
        }
        match frames.receiver.recv_timeout(FRAME_POLL_INTERVAL) {
            Ok(FrameMessage::Frame(frame)) => {
                return frame.map_err(|message| ExportError::FrameSource {
                    index,
                    message: truncate_message(message),
                });
            }
            Ok(FrameMessage::Finished) | Err(RecvTimeoutError::Disconnected) => {
                return Err(ExportError::FrameCount {
                    expected: frame_count,
                    actual: index,
                });
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

fn wait_for_finish(
    frames: &ExportFrameReceiver,
    frame_count: u64,
    cancellation: &CancellationToken,
) -> Result<(), ExportError> {
    loop {
        if cancellation.is_cancelled() {
            return Err(ExportError::Cancelled);
        }
        match frames.receiver.recv_timeout(FRAME_POLL_INTERVAL) {
            Ok(FrameMessage::Finished) => return Ok(()),
            Ok(FrameMessage::Frame(_)) => {
                return Err(ExportError::ExtraFrame {
                    expected: frame_count,
                });
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(ExportError::FrameStreamUnfinished {
                    actual: frame_count,
                });
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

pub(super) fn monitor_process(
    child: &mut std::process::Child,
    timeout: Duration,
    cancellation: &CancellationToken,
    writer: Option<&mpsc::Receiver<()>>,
) -> Result<ExitStatus, ExportError> {
    let started = Instant::now();
    loop {
        if cancellation.is_cancelled() {
            terminate(child);
            return Err(ExportError::Cancelled);
        }
        if started.elapsed() >= timeout {
            terminate(child);
            return Err(ExportError::TimedOut {
                timeout_ms: u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX),
            });
        }
        if let Some(writer) = writer
            && writer.try_recv().is_ok()
        {
            terminate(child);
            return Err(process_io("frame writer aborted"));
        }
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => thread::sleep(Duration::from_millis(2)),
            Err(error) => {
                terminate(child);
                return Err(process_io(error));
            }
        }
    }
}

pub(super) fn process_failed(code: Option<i32>, stderr: &[u8]) -> ExportError {
    ExportError::ProcessFailed {
        code,
        stderr: String::from_utf8_lossy(stderr).trim().to_owned(),
    }
}

pub(super) fn process_io(error: impl ToString) -> ExportError {
    ExportError::ProcessIo(error.to_string())
}

fn truncate_message(mut message: String) -> String {
    const LIMIT: usize = 1024;
    if message.len() <= LIMIT {
        return message;
    }
    let mut boundary = LIMIT;
    while !message.is_char_boundary(boundary) {
        boundary -= 1;
    }
    message.truncate(boundary);
    message
}
