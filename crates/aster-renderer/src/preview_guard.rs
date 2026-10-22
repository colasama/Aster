use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::BTreeMap,
    io::{self, BufRead, BufReader, Read, Write},
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    sync::{
        Arc,
        mpsc::{self, Receiver, RecvTimeoutError},
    },
    thread,
    time::Duration,
};
use windows::Win32::{
    Foundation::{
        DUPLICATE_CLOSE_SOURCE, DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE, WAIT_OBJECT_0,
    },
    System::Threading::{
        GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE, PROCESS_SYNCHRONIZE,
        WaitForSingleObject,
    },
};

#[derive(Debug, thiserror::Error)]
pub enum PreviewGuardError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Windows(#[from] windows::core::Error),
    #[error("invalid preview handle exchange: {0}")]
    Invalid(String),
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum GuardRequest {
    Borrow { sequence: u64, handle: usize },
    Release { sequence: u64 },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum GuardReply {
    Ready { process_id: u32 },
    Borrowed { sequence: u64, handle: usize },
    Released { sequence: u64 },
}

pub(crate) struct GuardWire;
impl GuardWire {
    pub fn reader<T: DeserializeOwned + Send + 'static>(
        input: impl Read + Send + 'static,
        maximum: usize,
    ) -> Receiver<Result<T, PreviewGuardError>> {
        let (send, receive) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut reader = BufReader::new(input);
            loop {
                let mut bytes = Vec::new();
                let result = match reader
                    .by_ref()
                    .take(maximum as u64 + 1)
                    .read_until(b'\n', &mut bytes)
                {
                    Ok(0) => break,
                    Ok(size) if size <= maximum && bytes.last() == Some(&b'\n') => {
                        serde_json::from_slice(&bytes).map_err(PreviewGuardError::from)
                    }
                    Ok(_) => Err(PreviewGuardError::Invalid(
                        "control exceeds its line budget".into(),
                    )),
                    Err(error) => Err(error.into()),
                };
                let failed = result.is_err();
                if send.send(result).is_err() || failed {
                    break;
                }
            }
        });
        receive
    }

    pub fn write(value: &impl Serialize, output: &mut impl Write) -> Result<(), PreviewGuardError> {
        // ChildStdin is unbuffered: emit the bounded control record in one write, not one per token.
        let mut line = serde_json::to_vec(value)?;
        line.push(b'\n');
        output.write_all(&line)?;
        output.flush()?;
        Ok(())
    }
}

struct RemoteHandle {
    consumer: Arc<OwnedHandle>,
    value: usize,
}
impl Drop for RemoteHandle {
    fn drop(&mut self) {
        let mut reclaimed = HANDLE::default();
        let result = unsafe {
            DuplicateHandle(
                HANDLE(self.consumer.as_raw_handle()),
                HANDLE(self.value as *mut _),
                GetCurrentProcess(),
                &mut reclaimed,
                0,
                false,
                DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS,
            )
        };
        if result.is_ok() {
            drop(unsafe { OwnedHandle::from_raw_handle(reclaimed.0) });
        }
    }
}

/// Owns consumer-process duplicates independently of the GPU producer's lifetime.
/// The producer can disappear between duplication and publication without leaking a consumer handle.
pub struct PreviewHandleGuard;
impl PreviewHandleGuard {
    pub fn serve(
        producer_pid: u32,
        consumer_pid: u32,
        slots: usize,
        maximum: usize,
    ) -> Result<(), PreviewGuardError> {
        if producer_pid == 0
            || consumer_pid == 0
            || !(1..=3).contains(&slots)
            || !(64..=65536).contains(&maximum)
        {
            return Err(PreviewGuardError::Invalid(
                "invalid process or transport limits".into(),
            ));
        }
        let producer = unsafe {
            OpenProcess(
                PROCESS_DUP_HANDLE | PROCESS_SYNCHRONIZE,
                false,
                producer_pid,
            )
        }?;
        let producer = unsafe { OwnedHandle::from_raw_handle(producer.0) };
        let consumer = unsafe { OpenProcess(PROCESS_DUP_HANDLE, false, consumer_pid) }?;
        let consumer = Arc::new(unsafe { OwnedHandle::from_raw_handle(consumer.0) });
        let input = GuardWire::reader::<GuardRequest>(io::stdin(), maximum);
        let mut output = io::BufWriter::new(io::stdout().lock());
        GuardWire::write(
            &GuardReply::Ready {
                process_id: std::process::id(),
            },
            &mut output,
        )?;
        let mut handles = BTreeMap::new();
        let mut latest = 0u64;
        loop {
            if unsafe { WaitForSingleObject(HANDLE(producer.as_raw_handle()), 0) } == WAIT_OBJECT_0
            {
                break;
            }
            let command = match input.recv_timeout(Duration::from_millis(100)) {
                Ok(command) => command?,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            let reply = match command {
                GuardRequest::Borrow { sequence, handle } => {
                    if sequence
                        != latest.checked_add(1).ok_or_else(|| {
                            PreviewGuardError::Invalid("sequence exhausted".into())
                        })?
                        || handle == 0
                        || handle == usize::MAX
                        || handles.len() >= slots
                    {
                        return Err(PreviewGuardError::Invalid(
                            "invalid borrowed handle or capacity".into(),
                        ));
                    }
                    let mut remote = HANDLE::default();
                    unsafe {
                        DuplicateHandle(
                            HANDLE(producer.as_raw_handle()),
                            HANDLE(handle as *mut _),
                            HANDLE(consumer.as_raw_handle()),
                            &mut remote,
                            0,
                            false,
                            DUPLICATE_SAME_ACCESS,
                        )
                    }?;
                    let value = remote.0 as usize;
                    handles.insert(
                        sequence,
                        RemoteHandle {
                            consumer: Arc::clone(&consumer),
                            value,
                        },
                    );
                    latest = sequence;
                    GuardReply::Borrowed {
                        sequence,
                        handle: value,
                    }
                }
                GuardRequest::Release { sequence } => {
                    let owned = handles.remove(&sequence).ok_or_else(|| {
                        PreviewGuardError::Invalid("unknown lease release".into())
                    })?;
                    drop(owned);
                    GuardReply::Released { sequence }
                }
            };
            GuardWire::write(&reply, &mut output)?;
        }
        drop(handles);
        Ok(())
    }
}
