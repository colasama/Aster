use super::*;
use std::{net::TcpListener, thread};

struct Pair;

impl Pair {
    fn open(timeout: Duration) -> Result<(RasterChannel, TcpStream), Box<dyn std::error::Error>> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let peer = TcpStream::connect(listener.local_addr()?)?;
        let (socket, _) = listener.accept()?;
        Ok((RasterChannel::new(socket, 32, timeout)?, peer))
    }
}

#[test]
fn fragmented_controls_preserve_binary_payload_boundaries() -> Result<(), Box<dyn std::error::Error>>
{
    let (mut channel, mut peer) = Pair::open(Duration::from_secs(2))?;
    let producer = thread::spawn(move || -> std::io::Result<()> {
        for byte in [3, 0, 0, 0, b'[', b'7', b']', 0, 255, 2] {
            peer.write_all(&[byte])?;
            thread::sleep(Duration::from_millis(1));
        }
        let mut reply = [0; 8];
        peer.read_exact(&mut reply)?;
        assert_eq!(reply, [4, 0, 0, 0, b'n', b'u', b'l', b'l']);
        Ok(())
    });
    let cancel = CancellationToken::default();
    assert_eq!(channel.receive::<Vec<u32>>(&cancel)?, vec![7]);
    assert_eq!(channel.read_bytes(3, &cancel)?, vec![0, 255, 2]);
    channel.send(&(), &cancel)?;
    producer.join().map_err(|_| "producer panicked")??;
    Ok(())
}

#[test]
fn malformed_lengths_json_and_disconnect_are_rejected() -> Result<(), Box<dyn std::error::Error>> {
    for data in [
        vec![0, 0, 0, 0],
        vec![33, 0, 0, 0],
        vec![1, 0, 0, 0, b'!'],
        vec![3, 0],
    ] {
        let (mut channel, mut peer) = Pair::open(Duration::from_secs(2))?;
        peer.write_all(&data)?;
        drop(peer);
        assert!(
            channel
                .receive::<Vec<u32>>(&CancellationToken::default())
                .is_err()
        );
    }
    Ok(())
}

#[test]
fn silent_peer_times_out_and_cancellation_interrupts_reads()
-> Result<(), Box<dyn std::error::Error>> {
    let (mut channel, _peer) = Pair::open(Duration::from_millis(75))?;
    let error = channel
        .receive::<Vec<u32>>(&CancellationToken::default())
        .err()
        .ok_or("timeout accepted")?;
    assert!(error.to_string().contains("timed out"));
    let (mut channel, _peer) = Pair::open(Duration::from_secs(5))?;
    let cancel = CancellationToken::default();
    let trigger = cancel.clone();
    let worker = thread::spawn(move || {
        thread::sleep(Duration::from_millis(30));
        trigger.cancel();
    });
    let started = Instant::now();
    assert!(channel.receive::<Vec<u32>>(&cancel).is_err());
    assert!(started.elapsed() < Duration::from_secs(2));
    worker.join().map_err(|_| "canceller panicked")?;
    Ok(())
}
