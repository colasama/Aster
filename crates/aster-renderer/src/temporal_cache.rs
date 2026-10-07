use std::{collections::BTreeMap, time::Duration};

use aster_render_ir::ResourceHash;
use serde::Serialize;

use crate::{
    RenderError, TemporalTextPass, TemporalTextPipeline, image_cache::ImageCache,
    image_input::ImageInput, temporal_frame::TemporalFrame,
};

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct TemporalCacheStatistics {
    pub allocations: u64,
    pub reuses: u64,
    pub evictions: u64,
    pub resident_bytes: u64,
    pub passes: u64,
    pub samples: u64,
}

struct CachedTemporal {
    generation: ResourceHash,
    prepared: TemporalTextPass,
    bytes: u64,
}

#[derive(Default)]
pub(crate) struct TemporalCache {
    pipeline: Option<TemporalTextPipeline>,
    entries: BTreeMap<ResourceHash, CachedTemporal>,
    pub statistics: TemporalCacheStatistics,
}

impl TemporalCache {
    /// Release obsolete targets before other frame caches can spend their reserved budget.
    pub fn retire(
        &mut self,
        device: &wgpu::Device,
        frame: &TemporalFrame,
        budget: u64,
        timeout: Duration,
    ) -> Result<(), RenderError> {
        if frame.required_bytes() > budget
            || frame.passes.values().any(|input| {
                input.plan.size.width > device.limits().max_texture_dimension_2d
                    || input.plan.size.height > device.limits().max_texture_dimension_2d
            })
        {
            return Err(RenderError::Invalid(
                "temporal frame exceeds GPU budget or dimensions".into(),
            ));
        }
        let stale = self
            .entries
            .iter()
            .filter(|(hash, cached)| {
                frame
                    .passes
                    .get(*hash)
                    .is_none_or(|input| input.generation != cached.generation)
            })
            .map(|(hash, _)| hash.clone())
            .collect::<Vec<_>>();
        if !stale.is_empty() {
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(timeout),
                })
                .map_err(|e| RenderError::Gpu(e.to_string()))?;
        }
        for hash in stale {
            if let Some(entry) = self.entries.remove(&hash) {
                self.statistics.resident_bytes -= entry.bytes;
                self.statistics.evictions += 1;
            }
        }
        self.statistics.passes = 0;
        self.statistics.samples = 0;
        Ok(())
    }

    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        frame: &TemporalFrame,
        inputs: &BTreeMap<ResourceHash, ImageInput>,
        images: &mut ImageCache,
    ) -> Result<(), RenderError> {
        if !frame.passes.is_empty() && self.pipeline.is_none() {
            self.pipeline = Some(TemporalTextPipeline::new(
                device,
                &aster_shaders::ShaderCatalog::embedded()?,
            )?);
        }
        for (hash, input) in &frame.passes {
            if let Some(entry) = self.entries.get(hash) {
                if entry.generation != input.generation {
                    return Err(RenderError::Invalid("stale temporal allocation".into()));
                }
                self.statistics.reuses += 1;
                continue;
            }
            let samples = input
                .plan
                .samples
                .iter()
                .map(|(hash, _)| {
                    let image = inputs.get(hash).ok_or_else(|| {
                        RenderError::Invalid("temporal sample upload absent".into())
                    })?;
                    Ok((hash.clone(), images.texture(image)?.clone()))
                })
                .collect::<Result<Vec<_>, RenderError>>()?;
            let pipeline = self
                .pipeline
                .as_ref()
                .ok_or_else(|| RenderError::Invalid("temporal pipeline absent".into()))?;
            let bytes = input.plan.required_bytes();
            let prepared = pipeline.prepare(device, &input.plan, &samples, bytes)?;
            self.entries.insert(
                hash.clone(),
                CachedTemporal {
                    generation: input.generation.clone(),
                    prepared,
                    bytes,
                },
            );
            self.statistics.allocations += 1;
            self.statistics.resident_bytes += bytes;
        }
        images.install_derived(
            device,
            self.entries
                .iter()
                .map(|(hash, cached)| {
                    (
                        hash.clone(),
                        cached.generation.clone(),
                        cached.prepared.output.clone(),
                    )
                })
                .collect(),
        );
        Ok(())
    }

    pub fn record(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        frame: &TemporalFrame,
    ) -> Result<(), RenderError> {
        if frame.passes.is_empty() {
            return Ok(());
        }
        let pipeline = self
            .pipeline
            .as_ref()
            .ok_or_else(|| RenderError::Invalid("temporal pipeline absent".into()))?;
        for (hash, input) in &frame.passes {
            let cached = self
                .entries
                .get(hash)
                .ok_or_else(|| RenderError::Invalid("temporal allocation absent".into()))?;
            pipeline.record(encoder, &cached.prepared);
            self.statistics.passes += 1;
            self.statistics.samples += input.plan.samples.len() as u64;
        }
        Ok(())
    }

    pub fn invalidate(&mut self) {
        self.statistics.evictions += self.entries.len() as u64;
        self.entries.clear();
        self.statistics.resident_bytes = 0;
    }
}
