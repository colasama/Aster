use crate::preview_guard::{GuardReply, GuardRequest, GuardWire, PreviewGuardError};
use std::{
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::Receiver,
    thread,
    time::{Duration, Instant},
};
use windows::Win32::{
    Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle, GetHandleInformation, HANDLE},
    System::Threading::{CreateEventW, GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE},
};

struct GuardFixture {
    producer: Child,
    guard: Child,
    input: Option<ChildStdin>,
    replies: Receiver<Result<GuardReply, PreviewGuardError>>,
}

impl GuardFixture {
    fn reply(&self) -> Result<GuardReply, Box<dyn std::error::Error>> {
        Ok(self.replies.recv_timeout(Duration::from_secs(5))??)
    }

    fn send(&mut self, command: GuardRequest) -> Result<GuardReply, Box<dyn std::error::Error>> {
        GuardWire::write(&command, self.input.as_mut().ok_or("guard input missing")?)?;
        self.reply()
    }

    fn valid(handle: usize) -> bool {
        let mut flags = 0;
        unsafe { GetHandleInformation(HANDLE(handle as *mut _), &mut flags) }.is_ok()
    }
}

impl Drop for GuardFixture {
    fn drop(&mut self) {
        self.input.take();
        let _ = self.producer.kill();
        let _ = self.producer.wait();
        let started = Instant::now();
        while self.guard.try_wait().ok().flatten().is_none()
            && started.elapsed() < Duration::from_secs(5)
        {
            thread::sleep(Duration::from_millis(10));
        }
        let _ = self.guard.kill();
        let _ = self.guard.wait();
    }
}

#[test]
#[ignore = "requires ASTER_PREVIEW_GUARD_EXE pointing to the built native CLI"]
fn preview_handle_guard_reclaims_after_producer_crash() -> Result<(), Box<dyn std::error::Error>> {
    let executable =
        std::env::var_os("ASTER_PREVIEW_GUARD_EXE").ok_or("guard executable missing")?;
    let event = unsafe { CreateEventW(None, false, false, None) }?;
    let event = unsafe { OwnedHandle::from_raw_handle(event.0) };
    let producer = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 120",
        ])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let mut guard = match Command::new(executable)
        .args([
            "preview-handle-guard",
            "--producer-pid",
            &producer.id().to_string(),
            "--consumer-pid",
            &std::process::id().to_string(),
            "--slots",
            "2",
            "--max-control-bytes",
            "4096",
        ])
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let mut producer = producer;
            let _ = producer.kill();
            let _ = producer.wait();
            return Err(error.into());
        }
    };
    let input = guard.stdin.take();
    let output = guard.stdout.take().ok_or("guard output missing")?;
    let mut fixture = GuardFixture {
        producer,
        guard,
        input,
        replies: GuardWire::reader(output, 4096),
    };
    assert!(
        matches!(fixture.reply()?, GuardReply::Ready { process_id } if process_id == fixture.guard.id())
    );
    let process = unsafe { OpenProcess(PROCESS_DUP_HANDLE, false, fixture.producer.id()) }?;
    let process = unsafe { OwnedHandle::from_raw_handle(process.0) };
    let mut remote = HANDLE::default();
    unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            HANDLE(event.as_raw_handle()),
            HANDLE(process.as_raw_handle()),
            &mut remote,
            0,
            false,
            DUPLICATE_SAME_ACCESS,
        )
    }?;
    let GuardReply::Borrowed {
        sequence: 1,
        handle: first,
    } = fixture.send(GuardRequest::Borrow {
        sequence: 1,
        handle: remote.0 as usize,
    })?
    else {
        return Err("first borrow identity differs".into());
    };
    assert!(GuardFixture::valid(first));
    assert!(matches!(
        fixture.send(GuardRequest::Release { sequence: 1 })?,
        GuardReply::Released { sequence: 1 }
    ));
    assert!(!GuardFixture::valid(first));
    let GuardReply::Borrowed {
        sequence: 2,
        handle: second,
    } = fixture.send(GuardRequest::Borrow {
        sequence: 2,
        handle: remote.0 as usize,
    })?
    else {
        return Err("second borrow identity differs".into());
    };
    assert!(GuardFixture::valid(second));
    fixture.producer.kill()?;
    fixture.producer.wait()?;
    // Keep the guard's input pipe open: cleanup must be driven by producer death, not pipe EOF.
    let started = Instant::now();
    while GuardFixture::valid(second) && started.elapsed() < Duration::from_secs(5) {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        !GuardFixture::valid(second),
        "consumer handle survived producer termination"
    );
    let started = Instant::now();
    let status = loop {
        if let Some(status) = fixture.guard.try_wait()? {
            break status;
        }
        if started.elapsed() >= Duration::from_secs(5) {
            return Err("guard did not exit after releasing the consumer handles".into());
        }
        thread::sleep(Duration::from_millis(10));
    };
    assert!(status.success());
    Ok(())
}
