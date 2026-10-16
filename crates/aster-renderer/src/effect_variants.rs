use std::collections::BTreeSet;

use crate::{RenderError, SuppliedFrame, output::OutputPipelines};

pub(super) struct EffectProgram;

impl EffectProgram {
    pub fn codes(operations: &[u8]) -> Option<Vec<u32>> {
        if operations.is_empty() || !operations.len().is_multiple_of(64) {
            return None;
        }
        let mut codes = BTreeSet::new();
        for op in operations.chunks_exact(64) {
            let code = f32::from_le_bytes([op[0], op[1], op[2], op[3]]);
            // Restrict specialization to the pixel-verified optical/color and wipe subset.
            // Morphology and other programs retain their original compiler path.
            if !matches!(
                code,
                12.0 | 17.0 | 18.0 | 27.0 | 50.0 | 62.0 | 82.0 | 102.0 | 104.0 | 105.0 | 183.0
            ) {
                return None;
            }
            codes.insert(code as u32);
        }
        Some(codes.into_iter().collect())
    }
}

impl OutputPipelines {
    /// Cache by reachable opcodes, not animated parameter values. Once full, new sets use the
    /// generic pipeline, bounding both resident pipelines and compilation work for the session.
    pub(crate) fn prepare_variants(
        &mut self,
        device: &wgpu::Device,
        frame: &SuppliedFrame,
        limit: usize,
    ) -> Result<(), RenderError> {
        for plan in std::iter::once(&frame.scene)
            .chain(frame.surfaces.targets.iter().map(|target| &target.scene))
            .flat_map(|scene| scene.layers.values())
        {
            if plan.operations.is_empty() {
                continue;
            }
            let Some(codes) = EffectProgram::codes(&plan.operations) else {
                self.prepare_effects(device)?;
                continue;
            };
            if self.variants.contains_key(&codes) {
                continue;
            }
            if self.variants.len() >= limit {
                self.prepare_effects(device)?;
                continue;
            }
            let catalog = aster_shaders::ShaderCatalog::embedded()?;
            let module = aster_shaders::PostShader::specialized_blur_cache(
                &catalog.program("post-process")?.source,
                &codes,
            )
            .map_err(RenderError::Invalid)?;
            let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
            let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
            let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Reachable shared layer effects"),
                source: wgpu::ShaderSource::Naga(std::borrow::Cow::Owned(module)),
            });
            let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Reachable layer program layout"),
                bind_group_layouts: &[Some(&self.post_layout)],
                immediate_size: 0,
            });
            let pipeline = Self::shader_pipeline(
                device,
                &shader,
                Some(&layout),
                "fragment_main",
                &[],
                wgpu::TextureFormat::Rgba16Float,
            );
            let validation_error = pollster::block_on(validation.pop());
            let internal_error = pollster::block_on(internal.pop());
            let memory_error = pollster::block_on(memory.pop());
            if let Some(error) = validation_error.or(internal_error).or(memory_error) {
                return Err(RenderError::Gpu(error.to_string()));
            }
            self.variants.insert(codes, pipeline);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::EffectProgram;

    #[test]
    fn variant_identity_ignores_parameters_and_preserves_opcode_coverage() {
        let mut operations = vec![0; 3 * 64];
        for (index, code) in [105_f32, 12.0, 105.0].into_iter().enumerate() {
            operations[index * 64..index * 64 + 4].copy_from_slice(&code.to_le_bytes());
        }
        assert_eq!(EffectProgram::codes(&operations), Some(vec![12, 105]));
        operations[4..8].copy_from_slice(&17_f32.to_le_bytes());
        assert_eq!(EffectProgram::codes(&operations), Some(vec![12, 105]));
        for unknown in [134.0_f32, 269.0, -1.0, 2.5, f32::NAN, f32::INFINITY] {
            operations[..4].copy_from_slice(&unknown.to_le_bytes());
            assert!(EffectProgram::codes(&operations).is_none());
        }
        assert!(EffectProgram::codes(&[]).is_none());
        assert!(EffectProgram::codes(&[0; 63]).is_none());
    }
}
