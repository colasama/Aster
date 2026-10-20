use super::{PlanComparison, PlanComparisonReport, PlanDifference};
use crate::{IrError, OwnedFpln, PlanSlice, PostEffect};

enum Lane {
    Exact(usize),
    F32,
    F64,
}
pub(super) struct Payload;

impl Payload {
    pub fn compare(
        a: &OwnedFpln,
        b: &OwnedFpln,
        path: &str,
        tolerance: &PlanComparison,
        report: &mut PlanComparisonReport,
    ) -> Result<Option<PlanDifference>, IrError> {
        for (index, _) in a.metadata.blobs.iter().enumerate() {
            let left = a.blob(index)?;
            let right = b.blob(index)?;
            let slice = a
                .metadata
                .slices
                .iter()
                .find(|s| Self::index(s) == index)
                .ok_or_else(|| IrError::InvalidHeader("untyped comparison blob".into()))?;
            let mut offset = 0;
            while offset < left.len() {
                let lane = Self::lane(slice, offset);
                let width = match lane {
                    Lane::Exact(n) => n,
                    Lane::F32 => 4,
                    Lane::F64 => 8,
                };
                let end = offset
                    .checked_add(width)
                    .ok_or(IrError::ArithmeticOverflow)?;
                let l = left.get(offset..end).ok_or(IrError::BlobRangeOutOfBounds)?;
                let r = right
                    .get(offset..end)
                    .ok_or(IrError::BlobRangeOutOfBounds)?;
                let value = match lane {
                    Lane::Exact(_) => None,
                    Lane::F32 => Some((
                        f32::from_le_bytes(l.try_into().map_err(|_| IrError::ElementCountMismatch)?)
                            as f64,
                        f32::from_le_bytes(r.try_into().map_err(|_| IrError::ElementCountMismatch)?)
                            as f64,
                    )),
                    Lane::F64 => Some((
                        f64::from_le_bytes(
                            l.try_into().map_err(|_| IrError::ElementCountMismatch)?,
                        ),
                        f64::from_le_bytes(
                            r.try_into().map_err(|_| IrError::ElementCountMismatch)?,
                        ),
                    )),
                };
                if value.is_some() {
                    report.compared_float_lanes += 1;
                }
                if l != r {
                    if let Some((a, b)) = value
                        && a.is_finite()
                        && b.is_finite()
                        && (a - b).abs()
                            <= tolerance
                                .absolute
                                .max(tolerance.relative * a.abs().max(b.abs()))
                    {
                        report.tolerated_float_differences += 1;
                    } else {
                        let (expected, actual) = value.map_or_else(
                            || (format!("{l:02x?}"), format!("{r:02x?}")),
                            |(a, b)| (a.to_string(), b.to_string()),
                        );
                        return Ok(Some(PlanDifference {
                            path: format!("{path}/blobs/{index}/byte/{offset}"),
                            kind: if value.is_some() {
                                "float"
                            } else {
                                "integer_or_bytes"
                            }
                            .into(),
                            expected,
                            actual,
                        }));
                    }
                }
                offset = end;
            }
        }
        Ok(None)
    }

    fn index(slice: &PlanSlice) -> usize {
        (match slice {
            PlanSlice::FrameBundle(s) => s.blob_index,
            PlanSlice::Auxiliary(s) => s.blob_index,
            PlanSlice::FinalOutput(s) => s.blob_index,
            PlanSlice::MotionReconstruction(s) => s.blob_index,
            PlanSlice::PostEffect(s) => s.blob_index,
            PlanSlice::PrecompositionBundle(s) => s.blob_index,
            PlanSlice::PrecompositionGraph(s) => s.blob_index,
            PlanSlice::SceneGenerator(s) => s.blob_index,
            PlanSlice::RootSceneCommands(s) => s.blob_index,
            PlanSlice::LayerEffect(s) => s.blob_index,
            PlanSlice::EffectExecution(s) => s.blob_index,
            PlanSlice::MaterialBinding(s) => s.blob_index,
            PlanSlice::PostProcessUniforms { blob_index } => *blob_index,
            PlanSlice::SceneBuffers(s) => s.blob_index,
            PlanSlice::CameraParameters(s) => s.blob_index,
            PlanSlice::TemporalTextSamples(s) => s.blob_index,
            PlanSlice::TemporalTextPasses(s) => s.blob_index,
        }) as usize
    }

    /// Mixed wire payloads retain integer/control lanes even when their ABI stores f32 bits.
    fn lane(slice: &PlanSlice, offset: usize) -> Lane {
        let word = offset / 4;
        match slice {
            PlanSlice::SceneBuffers(s) => {
                let exact = if word < 36 {
                    matches!(word, 11 | 14 | 15 | 35)
                } else if word < 148 {
                    matches!((word - 36) % 16, 7 | 11 | 14 | 15)
                } else if word < 148 + s.vertex_count as usize * 40 {
                    matches!((word - 148) % 40, 9 | 26 | 27 | 32 | 39)
                } else {
                    false
                };
                if exact { Lane::Exact(4) } else { Lane::F32 }
            }
            PlanSlice::PostProcessUniforms { .. } => {
                if matches!(word, 0 | 1 | 16..=19 | 23) {
                    Lane::Exact(4)
                } else {
                    Lane::F32
                }
            }
            PlanSlice::RootSceneCommands(_) | PlanSlice::MaterialBinding(_) => Lane::F64,
            PlanSlice::CameraParameters(_) => {
                if matches!(offset / 8, 27 | 28 | 36) {
                    Lane::Exact(8)
                } else {
                    Lane::F64
                }
            }
            PlanSlice::TemporalTextSamples(_) => {
                if offset == 0 || (offset >= 16 && (offset / 8 - 2) % 3 == 2) {
                    Lane::Exact(8)
                } else {
                    Lane::F64
                }
            }
            PlanSlice::TemporalTextPasses(_) => Lane::F64,
            PlanSlice::Auxiliary(s) => {
                if offset < s.draws.len() * 8 {
                    Lane::Exact(4)
                } else {
                    Lane::F32
                }
            }
            PlanSlice::MotionReconstruction(_) => {
                if matches!(word, 0 | 1 | 4 | 5) {
                    Lane::F32
                } else {
                    Lane::Exact(4)
                }
            }
            PlanSlice::LayerEffect(_) => {
                if offset >= 4192 {
                    Lane::F64
                } else if matches!(word, 0 | 1 | 16..=19)
                    || (offset >= 96 && (offset - 96).is_multiple_of(64))
                {
                    Lane::Exact(4)
                } else {
                    Lane::F32
                }
            }
            PlanSlice::SceneGenerator(_) => {
                if matches!(word, 6 | 7 | 36 | 37) || (2256..2288).contains(&offset) {
                    Lane::Exact(4)
                } else {
                    Lane::F32
                }
            }
            PlanSlice::PostEffect(s) => match s.effect {
                PostEffect::Depth { .. } => {
                    if matches!(word, 0..=3 | 18 | 24) {
                        Lane::Exact(4)
                    } else {
                        Lane::F32
                    }
                }
                PostEffect::Surface { .. } => {
                    if word == 4 {
                        Lane::F32
                    } else {
                        Lane::Exact(4)
                    }
                }
            },
            PlanSlice::FrameBundle(_)
            | PlanSlice::PrecompositionBundle(_)
            | PlanSlice::PrecompositionGraph(_)
            | PlanSlice::FinalOutput(_)
            | PlanSlice::EffectExecution(_) => Lane::Exact(4),
        }
    }
}
