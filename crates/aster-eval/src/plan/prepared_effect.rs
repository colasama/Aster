use crate::{
    BundleResources, EffectContext, EffectExecutionPlan, EffectProgram, EffectTrack,
    EvaluationError, LutPlan, NativePlan,
};
use aster_render_ir::{
    CompositionIdentity, ContractLevel, EffectExecutionRoute, FrameHeaderSlice,
    PrecompositionEffectRecord,
};
use aster_types::editor::Layer;

pub enum PreparedEffect {
    Direct {
        execution: EffectExecutionPlan,
    },
    Skipped {
        execution: EffectExecutionPlan,
    },
    Ready {
        execution: EffectExecutionPlan,
        prepared: Box<PreparedEffectProgram>,
    },
    Failed {
        execution: EffectExecutionPlan,
        error_utf16: Vec<u16>,
    },
}
pub struct PreparedEffectProgram {
    pub program: NativePlan,
    pub lut: LutPlan,
}
pub struct EffectPreparation {
    pub header: FrameHeaderSlice,
    pub instance_id: String,
    pub context: EffectContext,
    pub time: f64,
    pub pixel_scale: f64,
    pub mip_level_count: u32,
}
impl PreparedEffect {
    pub fn prepare(
        layer: &Layer,
        tracks: &[EffectTrack],
        input: EffectPreparation,
    ) -> Result<Self, EvaluationError> {
        let execution =
            EffectExecutionPlan::build(input.header, layer, &input.instance_id, input.context)?;
        match execution.route {
            EffectExecutionRoute::Direct => return Ok(Self::Direct { execution }),
            EffectExecutionRoute::Skip => return Ok(Self::Skipped { execution }),
            _ => {}
        }
        let build = || {
            // Adjustment programs may skip without touching an invalid, unused LUT.
            let program = EffectProgram::compile_slices(&[tracks], input.time, input.pixel_scale)?;
            if matches!(execution.route, EffectExecutionRoute::Adjustment) && program.count == 0 {
                return Ok(None);
            }
            let lut = LutPlan::prepare(layer)?;
            let program = execution.pack_program(
                &program,
                input.time,
                input.mip_level_count,
                lut.resource.request().hash.clone(),
            )?;
            Ok::<_, EvaluationError>(program.map(|program| (program, lut)))
        };
        match build() {
            Ok(Some((program, lut))) => Ok(Self::Ready {
                execution,
                prepared: Box::new(PreparedEffectProgram { program, lut }),
            }),
            Ok(None) => Ok(Self::Skipped { execution }),
            Err(error) => Ok(Self::Failed {
                execution,
                error_utf16: error.to_string().encode_utf16().collect(),
            }),
        }
    }
    pub fn record(
        &self,
        instance_id: CompositionIdentity,
        resources: &mut BundleResources,
    ) -> Result<PrecompositionEffectRecord, EvaluationError> {
        let execution = match self {
            Self::Direct { execution }
            | Self::Skipped { execution }
            | Self::Ready { execution, .. }
            | Self::Failed { execution, .. } => execution,
        };
        let execution =
            resources.add_plan(&execution.plan, ContractLevel::EffectExecutionSliceV1)?;
        Ok(match self {
            Self::Direct { .. } => PrecompositionEffectRecord::Direct {
                instance_id,
                execution,
            },
            Self::Skipped { .. } => PrecompositionEffectRecord::Skipped {
                instance_id,
                execution,
            },
            Self::Failed { error_utf16, .. } => PrecompositionEffectRecord::Failed {
                instance_id,
                execution,
                error_utf16: error_utf16.clone(),
            },
            Self::Ready { prepared, .. } => {
                let PreparedEffectProgram { program, lut } = prepared.as_ref();
                let hash = resources.add(lut.resource.clone())?;
                resources.require(std::slice::from_ref(&hash))?;
                PrecompositionEffectRecord::Ready {
                    instance_id,
                    execution,
                    plan: resources.add_plan(program, ContractLevel::LayerEffectsSliceV1)?,
                    lut: hash,
                    label_utf16: lut.label.encode_utf16().collect(),
                }
            }
        })
    }
}
