use std::io::{self, Write};

use aster_encode::{EncoderStatistics, HardwareEncoderProbe, PacketMetadata};
use aster_render::AdapterDiagnostics;
use aster_render_ir::{AdapterLuid, ExportVideoConfig, FrameHeaderSlice, ResourceStatistics};
use serde::Serialize;

#[derive(Serialize)]
pub(super) struct Reply {
    version: u32,
    request_id: Option<u64>,
    payload_bytes: u32,
    response: ReplyBody,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum ReplyBody {
    Capabilities {
        adapter: AdapterDiagnostics,
        adapter_luid: AdapterLuid,
        encoder: HardwareEncoderProbe,
        export_available: bool,
        reasons: Vec<String>,
    },
    ResourceStored {
        inserted: bool,
        usage: ResourceStatistics,
    },
    ResourceEvicted {
        usage: ResourceStatistics,
    },
    FrameChecked {
        plan_sha256: String,
        header: FrameHeaderSlice,
        usage: ResourceStatistics,
    },
    ExportStarted {
        video: ExportVideoConfig,
        frame_count: u64,
        adapter_luid: AdapterLuid,
        transport: &'static str,
        transport_reason: Option<String>,
        encoder: EncoderStatistics,
    },
    FrameWarmed {
        frame: FrameProof,
        warmup_frames: u64,
        encoder: EncoderStatistics,
    },
    Encoded {
        submitted_frame: Option<u64>,
        frame: Option<FrameProof>,
        packets: Vec<PacketMetadata>,
        encoder: EncoderStatistics,
        timings: Box<super::export::ExportTimings>,
        complete: bool,
    },
    ExportCancelled {
        encoder: Option<EncoderStatistics>,
    },
    Closed {},
    Error {
        code: String,
        message: String,
        terminal: bool,
    },
}

/// The supplied plan identity binds completed rendering to its authenticated inputs.
#[derive(Serialize)]
pub(super) struct FrameProof {
    pub(super) plan_sha256: String,
    pub(super) header: FrameHeaderSlice,
}

impl Reply {
    pub(super) fn write(
        output: &mut impl Write,
        max_control_bytes: usize,
        request_id: Option<u64>,
        response: ReplyBody,
        payload: &[u8],
    ) -> Result<(), Box<dyn std::error::Error>> {
        let reply = Self {
            version: 1,
            request_id,
            payload_bytes: u32::try_from(payload.len())?,
            response,
        };
        let mut encoded = ControlBuffer {
            bytes: Vec::new(),
            limit: max_control_bytes,
        };
        serde_json::to_writer(&mut encoded, &reply)?;
        encoded.write_all(b"\n")?;
        output.write_all(&encoded.bytes)?;
        output.write_all(payload)?;
        output.flush()?;
        Ok(())
    }
}

struct ControlBuffer {
    bytes: Vec<u8>,
    limit: usize,
}

impl Write for ControlBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(io::Error::other("session response exceeds control limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
