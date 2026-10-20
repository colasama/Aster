use super::{ExportError, ExportFrameReceiver, spec::FrameMessage};
use crate::CancellationToken;
use std::{io::Write, sync::mpsc::RecvTimeoutError};

#[derive(Clone, Copy)]
pub(super) enum FrameEncoding {
    Raw(usize),
    AnnexB { maximum_bytes: usize },
}

impl FrameEncoding {
    fn validate(self, frame: &[u8], index: u64) -> Result<(), ExportError> {
        match self {
            Self::Raw(expected) if frame.len() != expected => Err(ExportError::InvalidFrameSize {
                index,
                expected,
                actual: frame.len(),
            }),
            Self::AnnexB { maximum_bytes }
                if frame.len() < 5
                    || frame.len() > maximum_bytes
                    || !(frame.starts_with(&[0, 0, 0, 1]) || frame.starts_with(&[0, 0, 1])) =>
            {
                Err(ExportError::InvalidRequest(format!(
                    "encoded frame {index} is not a bounded Annex-B packet"
                )))
            }
            _ => Ok(()),
        }
    }
}

impl ExportFrameReceiver {
    pub(super) fn write_frames(
        mut stdin: impl Write,
        frames: ExportFrameReceiver,
        encoding: FrameEncoding,
        frame_count: u64,
        cancellation: &CancellationToken,
    ) -> Result<(), ExportError> {
        if frame_count == 0 {
            return Err(ExportError::InvalidRequest(
                "frame count must be positive".into(),
            ));
        }
        for index in 0..frame_count - 1 {
            let frame = frames.receive_frame(index, frame_count, cancellation)?;
            encoding.validate(&frame, index)?;
            stdin.write_all(&frame).map_err(ExportError::from)?;
        }

        // Hold the final frame until the producer closes the protocol with Finished.
        // FFmpeg therefore cannot satisfy `-frames:v N` and exit successfully while
        // a legitimate producer is about to send the finish marker.
        let final_index = frame_count - 1;
        let final_frame = frames.receive_frame(final_index, frame_count, cancellation)?;
        encoding.validate(&final_frame, final_index)?;
        frames.wait_for_finish(frame_count, cancellation)?;
        stdin.write_all(&final_frame).map_err(ExportError::from)?;
        stdin.flush().map_err(ExportError::from)
    }

    fn receive_frame(
        &self,
        index: u64,
        frame_count: u64,
        cancellation: &CancellationToken,
    ) -> Result<Vec<u8>, ExportError> {
        loop {
            if cancellation.is_cancelled() {
                return Err(ExportError::Cancelled);
            }
            match self.receiver.recv_timeout(self.poll_interval) {
                Ok(FrameMessage::Frame(frame)) => {
                    return frame.map_err(|message| ExportError::FrameSource {
                        index,
                        message: self.truncate_message(message),
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
        &self,
        frame_count: u64,
        cancellation: &CancellationToken,
    ) -> Result<(), ExportError> {
        loop {
            if cancellation.is_cancelled() {
                return Err(ExportError::Cancelled);
            }
            match self.receiver.recv_timeout(self.poll_interval) {
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

    fn truncate_message(&self, mut message: String) -> String {
        if message.len() <= self.max_error_bytes {
            return message;
        }
        let mut boundary = self.max_error_bytes;
        while !message.is_char_boundary(boundary) {
            boundary -= 1;
        }
        message.truncate(boundary);
        message
    }
}
