use std::io::{BufReader, Cursor};

use super::*;
use crate::{
    DecodeLimits, ExportVideoConfig, Extent2d, RationalFrameRate, SessionCommand, SessionSchema,
};

struct Fixture;
impl Fixture {
    fn reader(bytes: Vec<u8>) -> Result<SessionReader<BufReader<Cursor<Vec<u8>>>>, IrError> {
        SessionReader::new(
            BufReader::with_capacity(3, Cursor::new(bytes)),
            SessionWireLimits {
                max_control_bytes: 256,
                max_payload_bytes: 64,
            },
        )
    }
    fn packet(
        id: u64,
        command: SessionCommand,
        bytes: &[u8],
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let mut wire = serde_json::to_vec(&SessionRequest {
            version: 1,
            request_id: id,
            command,
        })?;
        wire.push(b'\n');
        wire.extend_from_slice(bytes);
        Ok(wire)
    }
}

#[test]
fn binary_newlines_and_fragmented_headers_cannot_split_a_frame()
-> Result<(), Box<dyn std::error::Error>> {
    let payload = [b'\n'; 32];
    let mut bytes = Fixture::packet(1, SessionCommand::CheckFrame { plan_bytes: 32 }, &payload)?;
    bytes.extend(Fixture::packet(2, SessionCommand::Shutdown {}, &[])?);
    let mut reader = Fixture::reader(bytes)?;
    assert_eq!(
        reader.read_packet()?.ok_or("packet missing")?.payload,
        payload
    );
    assert_eq!(
        reader
            .read_packet()?
            .ok_or("shutdown missing")?
            .request
            .command,
        SessionCommand::Shutdown {}
    );
    assert!(reader.read_packet()?.is_none());
    Ok(())
}

#[test]
fn session_schema_is_frozen_and_video_limits_precede_device_work()
-> Result<(), Box<dyn std::error::Error>> {
    let bytes = SessionSchema::emit()?;
    assert_eq!(bytes, SessionSchema::emit()?);
    let generated: serde_json::Value = serde_json::from_slice(&bytes)?;
    let frozen: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../schemas/render-session.v1.json"))?;
    assert_eq!(generated, frozen);
    let video = ExportVideoConfig {
        size: Extent2d {
            width: 1920,
            height: 1080,
        },
        frame_rate: RationalFrameRate {
            numerator: 30000,
            denominator: 1001,
        },
        bitrate_bps: 8_000_000,
    };
    video.validate(&DecodeLimits::default())?;
    for (width, height, numerator, denominator, bitrate) in [
        (1919, 1080, 30, 1, 8_000_000),
        (1920, 1079, 30, 1, 8_000_000),
        (0, 1080, 30, 1, 8_000_000),
        (1920, 1080, 60, 2, 8_000_000),
        (1920, 1080, 1, 2, 8_000_000),
        (1920, 1080, 241, 1, 8_000_000),
        (1920, 1080, 30, 0, 8_000_000),
        (1920, 1080, 30, 1, 63_999),
        (1920, 1080, 30, 1, 1_000_000_001),
    ] {
        let invalid = ExportVideoConfig {
            size: Extent2d { width, height },
            frame_rate: RationalFrameRate {
                numerator,
                denominator,
            },
            bitrate_bps: bitrate,
        };
        assert!(
            invalid.validate(&DecodeLimits::default()).is_err(),
            "{invalid:?}"
        );
    }
    Ok(())
}

#[test]
fn malformed_or_oversized_wire_poison_the_session() -> Result<(), Box<dyn std::error::Error>> {
    let mut invalid = vec![
        vec![b'x'; 257],
        b"{\"version\":1}".to_vec(),
        b"{\"version\":1,\"request_id\":1,\"command\":{\"type\":\"shutdown\",\"extra\":true}}\n"
            .to_vec(),
        b"{\"version\":2,\"request_id\":1,\"command\":{\"type\":\"shutdown\"}}\n".to_vec(),
        Fixture::packet(0, SessionCommand::Shutdown {}, &[])?,
        Fixture::packet(9_007_199_254_740_992, SessionCommand::Shutdown {}, &[])?,
        Fixture::packet(1, SessionCommand::CheckFrame { plan_bytes: 65 }, &[])?,
        Fixture::packet(1, SessionCommand::CheckFrame { plan_bytes: 31 }, &[])?,
        Fixture::packet(1, SessionCommand::CheckFrame { plan_bytes: 32 }, &[0; 31])?,
        Fixture::packet(1, SessionCommand::WarmFrame { plan_bytes: 31 }, &[0; 31])?,
        Fixture::packet(1, SessionCommand::WarmFrame { plan_bytes: 65 }, &[])?,
        Fixture::packet(1, SessionCommand::WarmFrame { plan_bytes: 32 }, &[0; 31])?,
        Fixture::packet(1, SessionCommand::RenderFrame { plan_bytes: 31, frame_index: 0 }, &[0; 31])?,
        Fixture::packet(1, SessionCommand::RenderFrame { plan_bytes: 32, frame_index: 9_007_199_254_740_992 }, &[0; 32])?,
        b"{\"version\":1,\"request_id\":1,\"command\":{\"type\":\"finish_export\",\"extra\":true}}\n".to_vec(),
        b"{\"version\":1,\"request_id\":1,\"command\":{\"type\":\"cancel_export\",\"extra\":true}}\n".to_vec(),
    ];
    for (index, bytes) in invalid.drain(..).enumerate() {
        let mut reader = Fixture::reader(bytes)?;
        assert!(reader.read_packet().is_err(), "invalid fixture {index}");
        assert!(reader.read_packet().is_err());
    }
    let mut duplicate = Fixture::packet(1, SessionCommand::Shutdown {}, &[])?;
    duplicate.extend(Fixture::packet(1, SessionCommand::Shutdown {}, &[])?);
    let mut reader = Fixture::reader(duplicate)?;
    assert!(reader.read_packet()?.is_some());
    assert!(reader.read_packet().is_err());
    let schema: serde_json::Value = serde_json::from_slice(&SessionSchema::emit()?)?;
    assert_eq!(schema["additionalProperties"], false);
    Ok(())
}
