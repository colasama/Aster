use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};

use crate::{
    GlyphTextAtlas, GlyphTextPass, GlyphTextPipeline, RenderError, glyph_frame::GlyphFrame,
    image_cache::ImageCache,
};
use aster_render_ir::ResourceHash;

/// Frame-bounded immutable atlas/output generations. No CPU composite or readback is involved.
#[derive(Default)]
pub(crate) struct GlyphCache {
    pipeline: Option<GlyphTextPipeline>,
    atlases: BTreeMap<ResourceHash, Arc<GlyphTextAtlas>>,
    outputs: BTreeMap<ResourceHash, GlyphTextPass>,
}

impl GlyphCache {
    pub fn retire(
        &mut self,
        device: &wgpu::Device,
        frame: &GlyphFrame,
        timeout: Duration,
    ) -> Result<(), RenderError> {
        let atlases = frame
            .inputs
            .values()
            .map(|i| i.atlas_identity.clone())
            .collect::<BTreeSet<_>>();
        let outputs = frame
            .inputs
            .values()
            .map(|i| i.generation.clone())
            .collect::<BTreeSet<_>>();
        if self.atlases.keys().any(|k| !atlases.contains(k))
            || self.outputs.keys().any(|k| !outputs.contains(k))
        {
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(timeout),
                })
                .map_err(|e| RenderError::Gpu(e.to_string()))?;
            self.outputs.retain(|k, _| outputs.contains(k));
            self.atlases.retain(|k, _| atlases.contains(k));
        }
        Ok(())
    }

    pub fn prepare(
        &mut self,
        gpu: (&wgpu::Device, &wgpu::Queue),
        frame: &GlyphFrame,
        images: &mut ImageCache,
    ) -> Result<(), RenderError> {
        let (device, queue) = gpu;
        if !frame.inputs.is_empty() && self.pipeline.is_none() {
            self.pipeline = Some(GlyphTextPipeline::new(
                device,
                &aster_shaders::ShaderCatalog::embedded()?,
            )?);
        }
        for input in frame.inputs.values() {
            if !self.atlases.contains_key(&input.atlas_identity) {
                let atlas = GlyphTextAtlas::upload(
                    device,
                    queue,
                    Arc::clone(&input.atlas),
                    Default::default(),
                    input.atlas_bytes,
                )?;
                self.atlases.insert(input.atlas_identity.clone(), atlas);
            }
            if !self.outputs.contains_key(&input.generation) {
                let atlas = self
                    .atlases
                    .get(&input.atlas_identity)
                    .ok_or_else(|| RenderError::Invalid("native glyph atlas absent".into()))?;
                let pipeline = self
                    .pipeline
                    .as_ref()
                    .ok_or_else(|| RenderError::Invalid("native glyph pipeline absent".into()))?;
                let output =
                    pipeline.prepare(device, Arc::clone(atlas), &input.plan, input.output_bytes)?;
                if output.generation != input.generation {
                    return Err(RenderError::Invalid(
                        "native glyph output identity differs".into(),
                    ));
                }
                self.outputs.insert(input.generation.clone(), output);
            }
        }
        images.install_derived(
            device,
            frame
                .inputs
                .values()
                .map(|input| {
                    let output = self
                        .outputs
                        .get(&input.generation)
                        .ok_or_else(|| RenderError::Invalid("native glyph output absent".into()))?;
                    Ok((
                        input.frame.clone(),
                        input.generation.clone(),
                        output.output.clone(),
                    ))
                })
                .collect::<Result<Vec<_>, RenderError>>()?,
        )?;
        Ok(())
    }

    pub fn record(&self, encoder: &mut wgpu::CommandEncoder) {
        if let Some(pipeline) = &self.pipeline {
            for output in self.outputs.values() {
                pipeline.record(encoder, output);
            }
        }
    }

    pub fn invalidate(&mut self) {
        self.outputs.clear();
        self.atlases.clear();
    }
}
