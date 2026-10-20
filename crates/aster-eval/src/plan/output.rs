use super::NativePlan;
use crate::EvaluationError;
use aster_render_ir::{
    ContractLevel, ElementType, FinalBeautySource, FinalDepthMode, FinalOutputRoute,
    FinalOutputSlice, FinalSurfaceMode, FinalVisualization, FrameHeaderSlice, PlanSlice,
};
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BufferVisualization {
    Beauty,
    LinearColor,
    Luminance,
    Alpha,
    DepthFog,
    DepthOfField,
    SelectionIsolation,
    VectorMotionBlur,
    Normal,
    ObjectId,
    MaterialId,
    WorldPosition,
    MotionVector,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameOutputSettings {
    pub visualization: BufferVisualization,
    pub auxiliary_valid: bool,
    pub beauty_depth_of_field: bool,
    pub motion_blur_valid: bool,
    pub motion_blur_binding_available: bool,
}

impl FrameOutputSettings {
    pub fn build(&self, header: FrameHeaderSlice) -> Result<NativePlan, EvaluationError> {
        let beauty = FinalOutputRoute::Beauty {
            source: if self.motion_blur_valid && self.motion_blur_binding_available {
                FinalBeautySource::MotionBlur
            } else {
                FinalBeautySource::Scene
            },
        };
        let route = if self.beauty_depth_of_field && self.auxiliary_valid {
            FinalOutputRoute::Depth {
                mode: FinalDepthMode::DepthOfField,
            }
        } else {
            match self.visualization {
                BufferVisualization::Beauty => beauty,
                BufferVisualization::SelectionIsolation | BufferVisualization::VectorMotionBlur
                    if !self.auxiliary_valid =>
                {
                    beauty
                }
                BufferVisualization::DepthFog => FinalOutputRoute::Depth {
                    mode: FinalDepthMode::DepthFog,
                },
                BufferVisualization::DepthOfField => FinalOutputRoute::Depth {
                    mode: FinalDepthMode::DepthOfField,
                },
                BufferVisualization::SelectionIsolation => FinalOutputRoute::Surface {
                    mode: FinalSurfaceMode::SelectionIsolation,
                },
                BufferVisualization::VectorMotionBlur => FinalOutputRoute::Surface {
                    mode: FinalSurfaceMode::VectorMotionBlur,
                },
                mode => FinalOutputRoute::Visualizer {
                    mode: match mode {
                        BufferVisualization::LinearColor => FinalVisualization::LinearColor,
                        BufferVisualization::Luminance => FinalVisualization::Luminance,
                        BufferVisualization::Alpha => FinalVisualization::Alpha,
                        BufferVisualization::Normal => FinalVisualization::Normal,
                        BufferVisualization::ObjectId => FinalVisualization::ObjectId,
                        BufferVisualization::MaterialId => FinalVisualization::MaterialId,
                        BufferVisualization::WorldPosition => FinalVisualization::WorldPosition,
                        BufferVisualization::MotionVector => FinalVisualization::MotionVector,
                        _ => {
                            return Err(EvaluationError::InvalidScene(
                                "invalid final visualization".into(),
                            ));
                        }
                    },
                },
            }
        };
        NativePlan::single(
            header,
            ContractLevel::FinalOutputSliceV1,
            PlanSlice::FinalOutput(FinalOutputSlice {
                blob_index: 0,
                route,
            }),
            ElementType::F32Le,
            [0.0_f32, 0.0, 0.0, 1.0]
                .iter()
                .flat_map(|n| n.to_le_bytes())
                .collect(),
            Vec::new(),
        )
    }
}
