use std::collections::{BTreeMap, BTreeSet};

use aster_render_ir::{EffectBlendMode, GeneratorBlend, ResourceHash};

use crate::{
    RenderError, SuppliedFrame, generator_bindings::GeneratorBindings,
    generator_input::GeneratorInput, generator_program::GeneratorProgram,
};

pub(crate) struct GeneratorPipelines {
    compute_layout: wgpu::BindGroupLayout,
    render_layout: wgpu::BindGroupLayout,
    programs: BTreeMap<ResourceHash, GeneratorProgram>,
    audio: Option<wgpu::Buffer>,
}

impl GeneratorPipelines {
    pub fn new(device: &wgpu::Device) -> Self {
        let layout = |compute| {
            let entries = (0..5)
                .filter(|binding| compute || *binding != 3)
                .map(|binding| wgpu::BindGroupLayoutEntry {
                    binding,
                    visibility: if compute {
                        wgpu::ShaderStages::COMPUTE
                    } else if binding == 2 {
                        wgpu::ShaderStages::VERTEX
                    } else {
                        wgpu::ShaderStages::VERTEX_FRAGMENT
                    },
                    ty: wgpu::BindingType::Buffer {
                        ty: if binding < 2 {
                            wgpu::BufferBindingType::Uniform
                        } else {
                            wgpu::BufferBindingType::Storage {
                                read_only: !compute || binding == 4,
                            }
                        },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                })
                .collect::<Vec<_>>();
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Scene generator ABI v1"),
                entries: &entries,
            })
        };
        Self {
            compute_layout: layout(true),
            render_layout: layout(false),
            programs: BTreeMap::new(),
            audio: None,
        }
    }

    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        frame: &SuppliedFrame,
    ) -> Result<(), RenderError> {
        let inputs = std::iter::once(&frame.scene)
            .chain(frame.surfaces.targets.iter().map(|s| &s.scene))
            .flat_map(|s| s.generators.values())
            .collect::<Vec<_>>();
        self.audio = (!inputs.is_empty())
            .then(|| GeneratorBindings::audio(device, frame.generator_audio.as_deref()));
        let active = inputs
            .iter()
            .map(|input| input.program_key.clone())
            .collect::<BTreeSet<_>>();
        self.programs.retain(|key, _| active.contains(key));
        for input in inputs {
            if let std::collections::btree_map::Entry::Vacant(entry) =
                self.programs.entry(input.program_key.clone())
            {
                entry.insert(GeneratorProgram::new(
                    device,
                    input,
                    &self.compute_layout,
                    &self.render_layout,
                )?);
            }
        }
        let auxiliary = [
            frame.motion.as_ref().map(|v| &v.auxiliary),
            frame.depth.as_ref().and_then(|v| v.auxiliary.as_ref()),
            frame.surface.as_ref().and_then(|v| v.auxiliary.as_ref()),
            frame.visualizer.as_ref().and_then(|v| v.auxiliary.as_ref()),
        ];
        for plan in auxiliary.into_iter().flatten() {
            for id in &plan.generators {
                let key = crate::surface_plan::SurfacePlan::key(id);
                let input = frame.scene.generators.get(&key).ok_or_else(|| {
                    RenderError::Invalid("auxiliary generator input absent".into())
                })?;
                self.programs
                    .get_mut(&input.program_key)
                    .ok_or_else(|| {
                        RenderError::Invalid("auxiliary generator program absent".into())
                    })?
                    .prepare_auxiliary(device, input, &self.render_layout)?;
            }
        }
        Ok(())
    }

    pub fn auxiliary_draws(
        &self,
        inputs: &BTreeMap<Vec<u16>, GeneratorInput>,
        bindings: &BTreeMap<Vec<u16>, GeneratorBindings>,
    ) -> Result<BTreeMap<Vec<u16>, crate::AuxiliaryGeneratorDraw>, RenderError> {
        let mut draws = BTreeMap::new();
        for (key, input) in inputs {
            let pipeline = self
                .programs
                .get(&input.program_key)
                .and_then(|p| p.variants.get(input.invocation.variant_index as usize))
                .and_then(|v| v.auxiliary.as_ref());
            if let Some(pipeline) = pipeline {
                let binding = bindings.get(key).ok_or_else(|| {
                    RenderError::Invalid("auxiliary generator buffers absent".into())
                })?;
                draws.insert(
                    key.clone(),
                    crate::AuxiliaryGeneratorDraw {
                        pipeline: pipeline.clone(),
                        binding: binding.render.clone(),
                        indirect: binding.indirect.clone(),
                    },
                );
            }
        }
        Ok(draws)
    }

    pub fn compute(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        inputs: &BTreeMap<Vec<u16>, GeneratorInput>,
    ) -> Result<BTreeMap<Vec<u16>, GeneratorBindings>, RenderError> {
        let mut bindings = BTreeMap::new();
        if inputs.is_empty() {
            return Ok(bindings);
        }
        let audio = self
            .audio
            .as_ref()
            .ok_or_else(|| RenderError::Invalid("frame generator audio binding absent".into()))?;
        for (key, input) in inputs {
            bindings.insert(
                key.clone(),
                GeneratorBindings::new(
                    device,
                    input,
                    (&self.compute_layout, &self.render_layout),
                    audio,
                )?,
            );
        }
        if !bindings.is_empty() {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Time-addressed scene generators"),
                timestamp_writes: None,
            });
            for (key, input) in inputs {
                let program = self
                    .programs
                    .get(&input.program_key)
                    .ok_or_else(|| RenderError::Invalid("compiled generator absent".into()))?;
                let binding = bindings
                    .get(key)
                    .ok_or_else(|| RenderError::Invalid("generator buffers absent".into()))?;
                pass.set_bind_group(0, &binding.compute, &[]);
                for (pipeline, count) in program.compute.iter().zip(&input.invocation.dispatches) {
                    pass.set_pipeline(pipeline);
                    pass.dispatch_workgroups(count[0], count[1], count[2]);
                }
            }
        }
        Ok(bindings)
    }

    pub fn draw(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        input: &GeneratorInput,
        bindings: &GeneratorBindings,
        blend: &EffectBlendMode,
    ) -> Result<(), RenderError> {
        let variant = self
            .programs
            .get(&input.program_key)
            .and_then(|p| p.variants.get(input.invocation.variant_index as usize))
            .ok_or_else(|| RenderError::Invalid("generator variant absent".into()))?;
        let key = if variant.mode == GeneratorBlend::Layer {
            SuppliedFrame::blend_index(blend)?
        } else {
            0
        };
        let pipeline = variant
            .pipelines
            .get(&key)
            .ok_or_else(|| RenderError::Invalid("generator blend pipeline absent".into()))?;
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &bindings.render, &[]);
        pass.draw_indirect(&bindings.indirect, 0);
        Ok(())
    }
}
