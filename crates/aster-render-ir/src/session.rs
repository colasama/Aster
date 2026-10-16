use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{DecodeLimits, Extent2d, IrError, PutResource, RationalFrameRate, ResourceHash};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AdapterLuid {
    pub low: u32,
    pub high: i32,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExportVideoConfig {
    pub size: Extent2d,
    pub frame_rate: RationalFrameRate,
    #[schemars(range(min = 64000, max = 1000000000))]
    pub bitrate_bps: u32,
}

impl ExportVideoConfig {
    pub fn validate(&self, limits: &DecodeLimits) -> Result<(), IrError> {
        self.size.validate(limits)?;
        self.frame_rate.validate()?;
        if !self.size.width.is_multiple_of(2)
            || !self.size.height.is_multiple_of(2)
            || !(64_000..=1_000_000_000).contains(&self.bitrate_bps)
            || self.frame_rate.numerator < self.frame_rate.denominator
            || u64::from(self.frame_rate.numerator) > 240 * u64::from(self.frame_rate.denominator)
        {
            return Err(IrError::InvalidResource(
                "export requires even dimensions, 1..240 fps and a bounded bitrate".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum SessionCommand {
    Probe {
        adapter_luid: Option<AdapterLuid>,
        video: ExportVideoConfig,
    },
    PutResource {
        resource: PutResource,
        payload_bytes: u32,
    },
    EvictResource {
        hash: ResourceHash,
    },
    CheckFrame {
        #[schemars(range(min = 32))]
        plan_bytes: u32,
    },
    WarmFrame {
        #[schemars(range(min = 32))]
        plan_bytes: u32,
    },
    BeginExport {
        video: ExportVideoConfig,
        #[schemars(range(min = 1, max = 9007199254740991_u64))]
        frame_count: u64,
    },
    RenderFrame {
        #[schemars(range(min = 32))]
        plan_bytes: u32,
        #[schemars(range(max = 9007199254740991_u64))]
        frame_index: u64,
    },
    FinishExport {},
    CancelExport {},
    Shutdown {},
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionRequest {
    #[schemars(range(min = 1, max = 1))]
    pub version: u32,
    #[schemars(range(min = 1, max = 9007199254740991_u64))]
    pub request_id: u64,
    pub command: SessionCommand,
}

impl SessionRequest {
    pub fn payload_bytes(&self, max_payload_bytes: usize) -> Result<usize, IrError> {
        if self.version != 1 || !(1..=9_007_199_254_740_991).contains(&self.request_id) {
            return Err(IrError::InvalidHeader(
                "session version or request identity".into(),
            ));
        }
        if matches!(self.command, SessionCommand::RenderFrame { frame_index, .. } if frame_index > 9_007_199_254_740_991)
            || matches!(self.command, SessionCommand::BeginExport { frame_count, .. } if !(1..=9_007_199_254_740_991).contains(&frame_count))
        {
            return Err(IrError::InvalidHeader("export frame identity".into()));
        }
        let bytes = match &self.command {
            SessionCommand::PutResource {
                resource,
                payload_bytes,
            } => {
                resource.hash.validate()?;
                *payload_bytes as usize
            }
            SessionCommand::CheckFrame { plan_bytes }
            | SessionCommand::WarmFrame { plan_bytes }
            | SessionCommand::RenderFrame { plan_bytes, .. }
                if *plan_bytes >= 32 =>
            {
                *plan_bytes as usize
            }
            SessionCommand::CheckFrame { .. }
            | SessionCommand::WarmFrame { .. }
            | SessionCommand::RenderFrame { .. } => {
                return Err(IrError::TruncatedHeader);
            }
            SessionCommand::EvictResource { hash } => {
                hash.validate()?;
                0
            }
            SessionCommand::Probe { .. }
            | SessionCommand::Shutdown {}
            | SessionCommand::BeginExport { .. }
            | SessionCommand::FinishExport {}
            | SessionCommand::CancelExport {} => 0,
        };
        if bytes > max_payload_bytes {
            return Err(IrError::LimitExceeded("session binary payload".into()));
        }
        Ok(bytes)
    }
}

pub struct SessionSchema;

impl SessionSchema {
    pub fn emit() -> Result<Vec<u8>, IrError> {
        let schema = schemars::schema_for!(SessionRequest);
        let canonical = crate::canonical::CanonicalJson::encode(&schema)?;
        let ordered: serde_json::Value = serde_json::from_slice(&canonical)
            .map_err(|error| IrError::InvalidJson(error.to_string()))?;
        let mut bytes = serde_json::to_vec_pretty(&ordered)
            .map_err(|error| IrError::InvalidJson(error.to_string()))?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}
