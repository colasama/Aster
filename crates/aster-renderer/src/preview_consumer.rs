use crate::{
    SharedPreviewFrame,
    preview_guard::{GuardReply, GuardRequest, GuardWire, PreviewGuardError},
};
use std::{
    io,
    os::windows::{
        io::{AsHandle, AsRawHandle},
        process::CommandExt,
    },
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex, mpsc::Receiver},
    thread,
    time::{Duration, Instant},
};

struct GuardConnection {
    child: Child,
    input: Option<ChildStdin>,
    replies: Receiver<Result<GuardReply, PreviewGuardError>>,
    timeout: Duration,
    latest: u64,
}

impl GuardConnection {
    fn exchange(&mut self, request: &GuardRequest) -> Result<GuardReply, PreviewGuardError> {
        let outcome = (|| {
            let input = self
                .input
                .as_mut()
                .ok_or_else(|| PreviewGuardError::Invalid("handle guard is closed".into()))?;
            GuardWire::write(request, input)?;
            self.replies.recv_timeout(self.timeout).map_err(|error| {
                PreviewGuardError::Invalid(format!("handle guard reply failed: {error}"))
            })?
        })();
        if outcome.is_err() {
            self.input.take();
        }
        outcome
    }
}

impl Drop for GuardConnection {
    fn drop(&mut self) {
        // EOF asks the independent owner to close all duplicates, including unpublished transfers.
        self.input.take();
        let started = Instant::now();
        while self.child.try_wait().ok().flatten().is_none() && started.elapsed() < self.timeout {
            thread::sleep(Duration::from_millis(10));
        }
        // Never force-kill the handle owner: it also watches producer death and must run cleanup.
    }
}

/// The independent guard owns handles in the importing process; the producer owns GPU surface leases.
pub struct PreviewConsumer {
    guard: Arc<Mutex<GuardConnection>>,
}

pub struct RemotePreviewFrame {
    guard: Arc<Mutex<GuardConnection>>,
    sequence: u64,
    remote: usize,
    _frame: SharedPreviewFrame,
}

impl PreviewConsumer {
    pub fn open(
        process_id: u32,
        executable: &Path,
        slots: u32,
        maximum: usize,
        timeout: Duration,
    ) -> Result<Self, PreviewGuardError> {
        if process_id == 0
            || !(1..=3).contains(&slots)
            || !(64..=65536).contains(&maximum)
            || timeout.is_zero()
            || timeout > Duration::from_secs(30)
        {
            return Err(PreviewGuardError::Invalid(
                "invalid handle guard configuration".into(),
            ));
        }
        let mut child = Command::new(executable)
            .args([
                "preview-handle-guard",
                "--producer-pid",
                &std::process::id().to_string(),
                "--consumer-pid",
                &process_id.to_string(),
                "--slots",
                &slots.to_string(),
                "--max-control-bytes",
                &maximum.to_string(),
            ])
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("handle guard stdin absent"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("handle guard stdout absent"))?;
        let guard = GuardConnection {
            child,
            input: Some(input),
            replies: GuardWire::reader(output, maximum),
            timeout,
            latest: 0,
        };
        match guard.replies.recv_timeout(timeout) {
            Ok(Ok(GuardReply::Ready { process_id })) if process_id == guard.child.id() => {}
            _ => {
                return Err(PreviewGuardError::Invalid(
                    "handle guard handshake failed".into(),
                ));
            }
        }
        Ok(Self {
            guard: Arc::new(Mutex::new(guard)),
        })
    }

    pub fn transfer(
        &self,
        frame: SharedPreviewFrame,
    ) -> Result<RemotePreviewFrame, PreviewGuardError> {
        let mut guard = self
            .guard
            .lock()
            .map_err(|_| PreviewGuardError::Invalid("handle guard mutex was poisoned".into()))?;
        let sequence = guard
            .latest
            .checked_add(1)
            .ok_or_else(|| PreviewGuardError::Invalid("handle sequence exhausted".into()))?;
        let reply = guard.exchange(&GuardRequest::Borrow {
            sequence,
            handle: frame.as_handle().as_raw_handle() as usize,
        })?;
        match reply {
            GuardReply::Borrowed {
                sequence: received,
                handle,
            } if received == sequence && handle != 0 && handle != usize::MAX => {
                guard.latest = sequence;
                Ok(RemotePreviewFrame {
                    guard: Arc::clone(&self.guard),
                    sequence,
                    remote: handle,
                    _frame: frame,
                })
            }
            _ => {
                guard.input.take();
                Err(PreviewGuardError::Invalid(
                    "borrowed handle identity differs".into(),
                ))
            }
        }
    }
}

impl RemotePreviewFrame {
    /// Exact pointer-width little-endian bytes, valid only in the bound importing process.
    pub fn handle_bytes(&self) -> Vec<u8> {
        self.remote.to_le_bytes().to_vec()
    }
}
impl Drop for RemotePreviewFrame {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.guard.lock() {
            let result = guard.exchange(&GuardRequest::Release {
                sequence: self.sequence,
            });
            if !matches!(result, Ok(GuardReply::Released { sequence }) if sequence == self.sequence)
            {
                guard.input.take();
            }
        }
    }
}
