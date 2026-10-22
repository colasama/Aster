use std::collections::{BTreeMap, BTreeSet};

use aster_render_ir::{EffectBlendMode, GeneratorBlend, ResourceHash};

use crate::{
    RenderError, SuppliedFrame, generator_bindings::GeneratorBindings,
    generator_input::GeneratorInput, generator_program::GeneratorProgram,
    generator_storage::GeneratorStoragePool,
};

pub(crate) struct GeneratorPipelines {
    compute_layout: wgpu::BindGroupLayout,
    render_layout: wgpu::BindGroupLayout,
    programs: BTreeMap<ResourceHash, GeneratorProgram>,
    audio: Option<wgpu::Buffer>,
    prepared: BTreeMap<ResourceHash, (GeneratorBindings, u64)>,
    prepared_audio: Option<std::sync::Arc<[u8]>>,
    recycled: GeneratorStoragePool,
    overwrite: crate::generator_overwrite::GeneratorOverwrite,
}

impl GeneratorPipelines {
    pub fn new(
        device: &wgpu::Device,
        overwrite: crate::generator_overwrite::GeneratorOverwrite,
    ) -> Self {
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
            prepared: BTreeMap::new(),
            prepared_audio: None,
            recycled: GeneratorStoragePool::default(),
            overwrite,
        }
    }

    pub fn begin_allocation(&mut self, budget: u64) {
        self.recycled.recycle(
            std::mem::take(&mut self.prepared)
                .into_values()
                .map(|(bindings, _)| bindings.storage.buffer),
            budget,
        );
        self.prepared_audio = None;
        self.audio = None;
    }

    pub fn allocated_bytes(&self) -> u64 {
        self.prepared.values().map(|(_, bytes)| *bytes).sum::<u64>()
            + self.recycled.bytes
            + if self.prepared.is_empty() { 0 } else { 9280 }
    }

    pub fn allocate(
        &mut self,
        device: &wgpu::Device,
        input: &GeneratorInput,
        budget: u64,
    ) -> Result<(), RenderError> {
        let key = input.allocation_key()?;
        if self.prepared.contains_key(&key) {
            return Ok(());
        }
        let bytes = self.prepared.values().map(|(_, bytes)| *bytes).sum::<u64>()
            + input.required_bytes()
            + 9280;
        if bytes > budget || self.prepared.len() >= 4096 {
            return Err(RenderError::Invalid(
                "generator preparation exceeds frame budget".into(),
            ));
        }
        if !self.prepared.is_empty() && self.prepared_audio.as_deref() != input.audio.as_deref() {
            return Err(RenderError::Invalid(
                "generator preparation audio changed".into(),
            ));
        }
        if let std::collections::btree_map::Entry::Vacant(entry) =
            self.programs.entry(input.program_key.clone())
        {
            entry.insert(GeneratorProgram::new(
                device,
                input,
                &self.compute_layout,
                &self.render_layout,
                &self.overwrite,
            )?);
        }
        if input.invocation.program.graph.render_variants[input.invocation.variant_index as usize]
            .auxiliary
            .is_some()
        {
            self.programs
                .get_mut(&input.program_key)
                .ok_or_else(|| RenderError::Invalid("generator program absent".into()))?
                .prepare_auxiliary(device, input, &self.render_layout)?;
        }
        let recycled = self.recycled.take(
            u64::from(input.invocation.capacity)
                * u64::from(input.invocation.program.graph.instance_stride),
            budget - bytes,
        );
        let audio = self
            .audio
            .get_or_insert_with(|| GeneratorBindings::audio(device, input.audio.as_deref()));
        let bindings = GeneratorBindings::new(
            device,
            input,
            (&self.compute_layout, &self.render_layout),
            audio,
            recycled,
        )?;
        self.prepared_audio = input.audio.clone();
        self.prepared
            .insert(key, (bindings, input.required_bytes()));
        Ok(())
    }

    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        frame: &SuppliedFrame,
        require_prepared: bool,
    ) -> Result<(), RenderError> {
        self.recycled = GeneratorStoragePool::default();
        let inputs = std::iter::once(&frame.scene)
            .chain(frame.surfaces.targets.iter().map(|s| &s.scene))
            .flat_map(|s| s.generators.values())
            .collect::<Vec<_>>();
        let allocation_keys = inputs
            .iter()
            .map(|input| input.allocation_key())
            .collect::<Result<BTreeSet<_>, _>>()?;
        if require_prepared && allocation_keys != self.prepared.keys().cloned().collect() {
            return Err(RenderError::Invalid(
                "final generator closure differs from allocations".into(),
            ));
        }
        self.prepared.retain(|key, _| allocation_keys.contains(key));
        if self.prepared.is_empty() {
            self.audio = (!inputs.is_empty())
                .then(|| GeneratorBindings::audio(device, frame.generator_audio.as_deref()));
        } else if frame
            .generator_audio
            .as_deref()
            .is_some_and(|audio| self.prepared_audio.as_deref() != Some(audio))
        {
            return Err(RenderError::Invalid(
                "prepared generator audio differs from frame".into(),
            ));
        }
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
                    &self.overwrite,
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
            if let Some((prepared, _)) = self.prepared.get(&input.allocation_key()?) {
                bindings.insert(key.clone(), prepared.clone());
                continue;
            }
            bindings.insert(
                key.clone(),
                GeneratorBindings::new(
                    device,
                    input,
                    (&self.compute_layout, &self.render_layout),
                    audio,
                    None,
                )?,
            );
        }
        if !bindings.is_empty() {
            for (key, input) in inputs {
                let program = self
                    .programs
                    .get(&input.program_key)
                    .ok_or_else(|| RenderError::Invalid("compiled generator absent".into()))?;
                let binding = bindings
                    .get(key)
                    .ok_or_else(|| RenderError::Invalid("generator buffers absent".into()))?;
                binding.storage.initialize(
                    encoder,
                    program.overwrites_instances
                        && crate::generator_overwrite::GeneratorOverwrite::invocation(input),
                );
            }
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
