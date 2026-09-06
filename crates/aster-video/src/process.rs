use crate::{CancellationToken, FfmpegError};
use std::{
    io::{self, Read},
    process::{Child, ExitStatus},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

pub(crate) struct MediaProcess {
    pub(crate) child: Child,
}

pub(crate) struct ProcessOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

pub(crate) struct BoundedRead {
    pub(crate) bytes: Vec<u8>,
    pub(crate) overflowed: bool,
}

pub(crate) type Reader = thread::JoinHandle<io::Result<BoundedRead>>;

impl BoundedRead {
    pub(crate) fn drain(mut reader: impl Read, limit: usize) -> io::Result<Self> {
        let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
        let mut overflowed = false;
        let mut chunk = [0_u8; 16 * 1024];
        loop {
            let count = reader.read(&mut chunk)?;
            if count == 0 {
                break;
            }
            let remaining = limit.saturating_sub(bytes.len());
            bytes.extend_from_slice(&chunk[..count.min(remaining)]);
            overflowed |= count > remaining;
        }
        Ok(Self { bytes, overflowed })
    }

    pub(crate) fn spawn(reader: impl Read + Send + 'static, limit: usize) -> Reader {
        thread::spawn(move || Self::drain(reader, limit))
    }

    pub(crate) fn join(reader: Reader) -> Result<Self, FfmpegError> {
        reader
            .join()
            .map_err(|_| FfmpegError::ProcessIo("process output reader panicked".into()))?
            .map_err(|error| FfmpegError::ProcessIo(error.to_string()))
    }
}

impl MediaProcess {
    pub(crate) fn monitor(
        &mut self,
        timeout: Duration,
        cancellation: &CancellationToken,
        writer: Option<&mpsc::Receiver<()>>,
    ) -> Result<ExitStatus, FfmpegError> {
        let started = Instant::now();
        loop {
            let failure = if cancellation.is_cancelled() {
                Some(FfmpegError::Cancelled)
            } else if started.elapsed() >= timeout {
                Some(FfmpegError::TimedOut {
                    timeout_ms: u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX),
                })
            } else if writer.is_some_and(|writer| writer.try_recv().is_ok()) {
                Some(FfmpegError::ProcessIo("frame writer aborted".into()))
            } else {
                None
            };
            if let Some(error) = failure {
                self.terminate();
                return Err(error);
            }
            match self.child.try_wait() {
                Ok(Some(status)) => return Ok(status),
                Ok(None) => thread::sleep(Duration::from_millis(2)),
                Err(error) => {
                    self.terminate();
                    return Err(FfmpegError::ProcessIo(error.to_string()));
                }
            }
        }
    }

    pub(crate) fn capture(
        mut self,
        timeout: Duration,
        max_stdout_bytes: usize,
        max_stderr_bytes: usize,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, FfmpegError> {
        let stdout = self
            .child
            .stdout
            .take()
            .ok_or_else(|| FfmpegError::ProcessIo("stdout pipe unavailable".into()))?;
        let stderr = self
            .child
            .stderr
            .take()
            .ok_or_else(|| FfmpegError::ProcessIo("stderr pipe unavailable".into()))?;
        let stdout_reader = BoundedRead::spawn(stdout, max_stdout_bytes);
        let stderr_reader = BoundedRead::spawn(stderr, max_stderr_bytes);
        let status = self.monitor(timeout, cancellation, None);
        // Join both readers even when either reports a failure.
        let stdout = BoundedRead::join(stdout_reader);
        let stderr = BoundedRead::join(stderr_reader);
        let status = status?;
        let stdout = stdout?;
        let stderr = stderr?;
        if stdout.overflowed {
            return Err(FfmpegError::OutputTooLarge {
                stream: "stdout",
                limit: max_stdout_bytes,
            });
        }
        if stderr.overflowed {
            return Err(FfmpegError::OutputTooLarge {
                stream: "stderr",
                limit: max_stderr_bytes,
            });
        }
        Ok(ProcessOutput {
            status,
            stdout: stdout.bytes,
            stderr: stderr.bytes,
        })
    }

    fn terminate(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for MediaProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}
