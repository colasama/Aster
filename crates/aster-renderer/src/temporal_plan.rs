use aster_render_ir::{ContractLevel, Extent2d, OwnedFpln, PlanSlice, ResourceHash};

use crate::RenderError;

/// Sample identities and exposure weights captured by the producer, independent of project state.
pub struct TemporalTextPlan {
    pub(crate) size: Extent2d,
    pub(crate) output: ResourceHash,
    pub(crate) samples: Vec<(ResourceHash, f32)>,
}

impl TemporalTextPlan {
    pub fn new(plan: &OwnedFpln) -> Result<Self, RenderError> {
        let Some(PlanSlice::TemporalTextPasses(pass)) = plan.metadata.slices.first() else {
            return Err(RenderError::Invalid("temporal text pass missing".into()));
        };
        if plan.metadata.contract_level != ContractLevel::TemporalTextPassesSliceV1
            || plan.metadata.slices.len() != 1
        {
            return Err(RenderError::Unsupported(
                "non-temporal text contract".into(),
            ));
        }
        let descriptor = plan
            .metadata
            .blobs
            .get(pass.blob_index as usize)
            .ok_or_else(|| RenderError::Invalid("temporal blob descriptor absent".into()))?;
        pass.validate(descriptor, &plan.metadata.resources)?;
        let bytes = plan.blob(pass.blob_index as usize)?;
        pass.validate_payload(bytes)?;
        let samples = pass
            .samples
            .iter()
            .zip(bytes.chunks_exact(8).skip(1))
            .map(|(hash, lane)| {
                let lane = lane
                    .try_into()
                    .map_err(|_| RenderError::Invalid("temporal exposure lane differs".into()))?;
                Ok((hash.clone(), f64::from_le_bytes(lane) as f32))
            })
            .collect::<Result<Vec<_>, RenderError>>()?;
        Ok(Self {
            size: Extent2d {
                width: pass.width,
                height: pass.height,
            },
            output: pass.output.clone(),
            samples,
        })
    }

    /// Targets and aligned uniforms retained by one prepared pass; sampled textures are caller-owned.
    pub fn required_bytes(&self) -> u64 {
        u64::from(self.size.width) * u64::from(self.size.height) * 12
            + self.samples.len() as u64 * 256
    }
}
