use crate::{
    RenderError, SuppliedFrame,
    depth_auxiliary::{DepthAuxiliaryPipelines, DepthTargets},
    frame_depth::FrameDepth,
};
use aster_render_ir::PostEffectInput;
use wgpu::util::DeviceExt;

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct DepthStatistics {
    pub allocations: u64,
    pub reuses: u64,
    pub retirements: u64,
    pub resident_bytes: u64,
    pub passes: u64,
}

pub(crate) struct DepthOutput {
    auxiliary: DepthAuxiliaryPipelines,
    effect: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    targets: Option<DepthTargets>,
    pub statistics: DepthStatistics,
}

impl DepthOutput {
    pub fn new(device: &wgpu::Device, layout: &wgpu::BindGroupLayout) -> Result<Self, RenderError> {
        let catalog = aster_shaders::ShaderCatalog::embedded()?;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared depth post shader"),
            source: wgpu::ShaderSource::Wgsl(
                catalog.program("depth-effects")?.source.clone().into(),
            ),
        });
        let effect = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Supplied native depth effect"),
            layout: None,
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vertex_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fragment_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Bgra8Unorm,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        Ok(Self {
            auxiliary: DepthAuxiliaryPipelines::new(device, &catalog, layout)?,
            effect,
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                min_filter: wgpu::FilterMode::Linear,
                mag_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
            targets: None,
            statistics: Default::default(),
        })
    }

    pub fn retire(
        &mut self,
        device: &wgpu::Device,
        plan: Option<&FrameDepth>,
        timeout: std::time::Duration,
    ) -> Result<(), RenderError> {
        self.statistics.passes = plan.map_or(0, |p| {
            u64::from(p.ready)
                + p.auxiliary.as_ref().map_or(0, |_| {
                    if p.tier >= 2 {
                        4
                    } else if p.tier >= 1 {
                        3
                    } else {
                        1
                    }
                })
        });
        let reusable = self.targets.as_ref().zip(plan).is_some_and(|(t, p)| {
            p.auxiliary.as_ref().is_some_and(|a| {
                t.size == a.size && t.tier == p.tier && t.bytes == p.required_bytes()
            })
        });
        if reusable {
            self.statistics.reuses += 1;
            return Ok(());
        }
        if self.targets.is_some() {
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(timeout),
                })
                .map_err(|e| RenderError::Gpu(e.to_string()))?;
            self.targets = None;
            self.statistics.retirements += 1;
            self.statistics.resident_bytes = 0;
        }
        Ok(())
    }

    pub fn allocate(
        &mut self,
        device: &wgpu::Device,
        plan: Option<&FrameDepth>,
    ) -> Result<(), RenderError> {
        if self.targets.is_none()
            && let Some(plan) = plan.filter(|p| p.auxiliary.is_some())
        {
            let targets = DepthTargets::new(device, plan)?;
            self.statistics.resident_bytes = u64::from(targets.size.width)
                * u64::from(targets.size.height)
                * (32
                    + if targets.tier >= 1 { 16 } else { 0 }
                    + if targets.tier >= 2 { 20 } else { 0 });
            self.targets = Some(targets);
            self.statistics.allocations += 1;
        }
        Ok(())
    }

    pub fn record(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        frame: &SuppliedFrame,
        textures: (&wgpu::Texture, Option<&wgpu::Texture>, &wgpu::Texture),
        caches: (
            &crate::image_cache::ImageCache,
            &crate::surface_cache::SurfaceCache,
        ),
    ) -> Result<(), RenderError> {
        let plan = frame
            .depth
            .as_ref()
            .ok_or_else(|| RenderError::Invalid("depth output missing".into()))?;
        if let Some(auxiliary) = &plan.auxiliary {
            let targets = self
                .targets
                .as_ref()
                .ok_or_else(|| RenderError::Invalid("depth targets missing".into()))?;
            let bindings = auxiliary.bindings(frame, caches)?;
            self.auxiliary.record(
                device,
                encoder,
                plan,
                targets,
                &bindings.iter().map(Option::as_ref).collect::<Vec<_>>(),
            )?;
        }
        let bind = if plan.ready {
            let targets = self
                .targets
                .as_ref()
                .ok_or_else(|| RenderError::Invalid("depth targets missing".into()))?;
            let inputs = plan
                .inputs
                .iter()
                .map(|input| match input {
                    PostEffectInput::Scene => Ok(textures.0),
                    PostEffectInput::MotionBlur => textures
                        .1
                        .ok_or_else(|| RenderError::Invalid("depth motion source absent".into())),
                    PostEffectInput::WorldPosition => Ok(&targets.primary.colors[3]),
                    PostEffectInput::TransparentWorldPosition => targets
                        .colors
                        .get(1)
                        .ok_or_else(|| RenderError::Invalid("transparent depth absent".into())),
                    PostEffectInput::FrontLayerColor => targets
                        .colors
                        .first()
                        .ok_or_else(|| RenderError::Invalid("front color absent".into())),
                    PostEffectInput::PeeledWorldPosition => targets
                        .colors
                        .get(2)
                        .ok_or_else(|| RenderError::Invalid("peeled depth absent".into())),
                    PostEffectInput::PeeledLayerColor => targets
                        .colors
                        .get(3)
                        .ok_or_else(|| RenderError::Invalid("peeled color absent".into())),
                    _ => Err(RenderError::Unsupported("depth input role".into())),
                })
                .collect::<Result<Vec<_>, _>>()?;
            let views = inputs
                .iter()
                .map(|t| t.create_view(&Default::default()))
                .collect::<Vec<_>>();
            let uniforms = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Supplied depth uniforms"),
                contents: &plan.uniforms,
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let mut entries = [0, 1, 4, 5, 6, 7]
                .into_iter()
                .zip(&views)
                .map(|(binding, view)| wgpu::BindGroupEntry {
                    binding,
                    resource: wgpu::BindingResource::TextureView(view),
                })
                .collect::<Vec<_>>();
            entries.push(wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Sampler(&self.sampler),
            });
            entries.push(wgpu::BindGroupEntry {
                binding: 3,
                resource: uniforms.as_entire_binding(),
            });
            Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Supplied depth attachments"),
                layout: &self.effect.get_bind_group_layout(0),
                entries: &entries,
            }))
        } else {
            None
        };
        let output = textures.2.create_view(&Default::default());
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Native depth output"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &output,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(frame.output_clear),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        if let Some(bind) = &bind {
            pass.set_pipeline(&self.effect);
            pass.set_bind_group(0, bind, &[]);
            pass.draw(0..3, 0..1);
        }
        Ok(())
    }
}
