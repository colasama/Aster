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
    control.pause(true)?;
    let worker_control = control.clone();
    let (send, receive) = mpsc::channel();
    let worker = thread::spawn(move || {
        let result = worker_control.wait();
        let _ = send.send(result.is_ok());
    });
    assert!(receive.recv_timeout(Duration::from_millis(80)).is_err());
    control.pause(false)?;
    assert!(receive.recv_timeout(Duration::from_secs(2))?);
    worker.join().map_err(|_| "worker panicked")?;
    control.pause(true)?;
    control.cancellation.cancel();
    assert!(control.wait().is_err());
    Ok(())
}
