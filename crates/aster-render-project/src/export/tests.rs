use super::*;
use aster_encode::PacketMetadata;
use std::{sync::mpsc, thread, time::Duration};

#[test]
fn malformed_encoder_receipts_never_enter_mux_queue() -> Result<(), Box<dyn std::error::Error>> {
    for change in 0..5 {
        let (sender, _receiver) = ExportLimits::default().frame_channel(2)?;
        let mut sink = PacketSink {
            sender,
            rate: RationalFrameRate {
                numerator: 30000,
                denominator: 1001,
            },
            accepted: 0,
            count: 2,
            maximum_bytes: 8,
        };
        let mut packet = EncodedPacket {
            metadata: PacketMetadata {
                frame_index: 0,
                timestamp_100ns: 0,
                duration_100ns: 333666,
                payload_bytes: 5,
            },
            bytes: vec![0, 0, 0, 1, 9],
        };
        match change {
            0 => packet.metadata.frame_index = 1,
            1 => packet.metadata.timestamp_100ns = 1,
            2 => packet.metadata.duration_100ns = 1,
            3 => packet.metadata.payload_bytes = 8,
            _ => packet.bytes.resize(9, 0),
        }
        assert!(sink.push(vec![packet]).is_err());
        assert_eq!(sink.accepted, 0);
    }
    Ok(())
}

#[test]
fn pause_waits_for_resume_and_cancel_releases_pause() -> Result<(), Box<dyn std::error::Error>> {
    let control = ProjectExportControl::default();
    control.pause(true, None)?;
    let worker_control = control.clone();
    let (send, receive) = mpsc::channel();
    let worker = thread::spawn(move || {
        let result = worker_control.wait();
        let _ = send.send(result.is_ok());
    });
    assert!(receive.recv_timeout(Duration::from_millis(80)).is_err());
    control.pause(false, None)?;
    assert!(receive.recv_timeout(Duration::from_secs(2))?);
    worker.join().map_err(|_| "worker panicked")?;
    control.pause(true, None)?;
    control.cancellation.cancel();
    assert!(control.wait().is_err());
    Ok(())
}

#[test]
fn pause_acknowledgments_follow_processing_boundaries() -> Result<(), Box<dyn std::error::Error>> {
    let (notice, notices) = mpsc::channel();
    let control = ProjectExportControl::default().with_pause_observer(move |id| {
        let _ = notice.send(id);
    });
    control.pause(true, Some(1))?;
    assert!(notices.try_recv().is_err());
    let worker_control = control.clone();
    let (done, completion) = mpsc::channel();
    let worker = thread::spawn(move || {
        let _ = done.send(worker_control.wait().is_ok());
    });
    assert_eq!(notices.recv_timeout(Duration::from_secs(2))?, Some(1));
    assert!(completion.recv_timeout(Duration::from_millis(80)).is_err());
    assert!(notices.try_recv().is_err());
    control.pause(true, Some(2))?;
    assert_eq!(notices.recv_timeout(Duration::from_secs(2))?, Some(2));
    control.cancellation.cancel();
    assert!(!completion.recv_timeout(Duration::from_secs(2))?);
    worker.join().map_err(|_| "worker panicked")?;
    Ok(())
}

#[test]
fn pause_observer_can_resume_without_lock_reentrancy() -> Result<(), Box<dyn std::error::Error>> {
    let control = ProjectExportControl::default();
    let resume = control.clone();
    let (notice, notices) = mpsc::channel();
    let control = control.with_pause_observer(move |id| {
        let result = resume.pause(false, None);
        let _ = notice.send((id, result.is_ok()));
    });
    control.pause(true, Some(3))?;
    let (done, completion) = mpsc::channel();
    let worker = thread::spawn(move || {
        let _ = done.send(control.wait().is_ok());
    });
    assert_eq!(
        notices.recv_timeout(Duration::from_secs(2))?,
        (Some(3), true)
    );
    assert!(completion.recv_timeout(Duration::from_secs(2))?);
    worker.join().map_err(|_| "worker panicked")?;
    Ok(())
}
