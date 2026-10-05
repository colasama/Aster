use crate::{BlobDescriptor, ElementType, FrameHeaderSlice, IrError};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PostEffectSlice {
    pub blob_index: u32,
    pub status: PostEffectStatus,
    pub effect: PostEffect,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PostEffectStatus {
    Ready,
    Skipped,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PostEffect {
    Depth {
        mode: DepthEffectMode,
        inputs: [PostEffectInput; 6],
    },
    Surface {
        mode: SurfaceEffectMode,
        inputs: [PostEffectInput; 3],
    },
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DepthEffectMode {
    DepthFog,
    DepthOfField,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SurfaceEffectMode {
    SelectionIsolation,
    VectorMotionBlur,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PostEffectInput {
    Scene,
    #[serde(rename = "motion_blur")]
    MotionBlur,
    WorldPosition,
    TransparentWorldPosition,
    PeeledWorldPosition,
    FrontLayerColor,
    PeeledLayerColor,
    ObjectId,
    MotionVector,
}
impl PostEffectSlice {
    pub fn validate(&self, blob: &BlobDescriptor) -> Result<(), IrError> {
        use PostEffectInput::*;
        let (size, valid) = match &self.effect {
            PostEffect::Depth { inputs, .. } => (
                128,
                matches!(inputs[0], Scene | MotionBlur)
                    && inputs[1] == WorldPosition
                    && matches!(inputs[2], WorldPosition | TransparentWorldPosition)
                    && matches!(inputs[3], WorldPosition | PeeledWorldPosition)
                    && matches!(inputs[4], Scene | MotionBlur | FrontLayerColor)
                    && matches!(inputs[5], Scene | MotionBlur | PeeledLayerColor),
            ),
            PostEffect::Surface { inputs, .. } => (32, *inputs == [Scene, ObjectId, MotionVector]),
        };
        if !valid
            || blob.element_type != ElementType::U8
            || blob.element_count != size
            || blob.byte_length != size
        {
            return Err(IrError::InvalidHeader("post effect layout".to_owned()));
        }
        Ok(())
    }
    pub fn validate_bytes(&self, bytes: &[u8], header: &FrameHeaderSlice) -> Result<(), IrError> {
        let (size, depth, mode) = match self.effect {
            PostEffect::Depth { ref mode, .. } => (
                128,
                true,
                if *mode == DepthEffectMode::DepthFog {
                    1
                } else {
                    2
                },
            ),
            PostEffect::Surface { ref mode, .. } => (
                32,
                false,
                if *mode == SurfaceEffectMode::SelectionIsolation {
                    1
                } else {
                    2
                },
            ),
        };
        if bytes.len() != size {
            return Err(IrError::InvalidHeader(
                "post effect payload length".to_owned(),
            ));
        }
        let word = |i: usize| {
            let o = i * 4;
            u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]])
        };
        let f = |i| f32::from_bits(word(i));
        if f(0) != header.render_target.width as f32
            || f(1) != header.render_target.height as f32
            || (if depth {
                f(2) != mode as f32
            } else {
                word(2) != mode
            })
        {
            return Err(IrError::InvalidHeader(
                "post effect viewport or mode".to_owned(),
            ));
        }
        if !depth {
            if !f(4).is_finite() || !(0.0..=4.0).contains(&f(4)) || (5..8).any(|i| word(i) != 0) {
                return Err(IrError::InvalidHeader("surface controls".to_owned()));
            }
            return Ok(());
        }
        let ranges = [
            (3, 8.0, 64.0),
            (4, 0.0, 16.0),
            (5, 0.0, 16.0),
            (6, 0.0, 16.0),
            (7, 0.0, 1.0),
            (11, 0.0, 100_000.0),
            (15, 0.001, 10_000_000.0),
            (16, 0.0, 10_000_000.0),
            (17, 0.0, 10_000.0),
            (18, 0.0, 2.0),
            (19, 0.001, 10_000_000.0),
            (20, 0.0, 10.0),
            (21, 0.0, 10.0),
            (22, 0.0, 10.0),
            (23, 0.0, 256.0),
            (24, 1.0, 10.0),
            (25, -std::f32::consts::TAU, std::f32::consts::TAU),
            (26, 0.0, 1.0),
            (27, 1.0, 100.0),
            (28, 0.0, 1.0),
            (29, 0.0, 1.0),
            (30, 0.0, 1.0),
            (31, 0.0, 1.0),
        ];
        if (0..32).any(|i| !f(i).is_finite())
            || ranges
                .iter()
                .any(|&(i, min, max)| !(min..=max).contains(&f(i)))
        {
            return Err(IrError::InvalidHeader("depth controls".to_owned()));
        }
        Ok(())
    }
}
