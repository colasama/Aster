use std::collections::BTreeMap;

use aster_render::{TextureResource, TextureResourceDescriptor};
use aster_render_ir::Extent2d;
use aster_shaders::ShaderCatalog;

use crate::{RenderError, layer_plan::LayerPlan, output::OutputPipelines};

pub(crate) struct LayerTargets {
    pub input: TextureResource,
    pub output: TextureResource,
    pub depth: TextureResource,
    pub blur: Option<crate::pyramid::Pyramid>,
    pub glow: Option<crate::pyramid::Pyramid>,
}

pub(crate) struct LayerPipelines {
    pyramids: crate::pyramid::PyramidPipelines,
    fixed: crate::fixed_composite::FixedComposite,
    layout: wgpu::BindGroupLayout,
    pipelines: BTreeMap<u8, wgpu::RenderPipeline>,
}

impl LayerTargets {
    pub fn new(device: &wgpu::Device, size: Extent2d, blur: bool, glow: bool) -> Self {
        let create = |label, format, usage| {
            TextureResource::create(
                device,
                TextureResourceDescriptor::texture_2d(
                    label,
                    size.width,
                    size.height,
                    format,
                    usage,
                ),
            )
        };
        let usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
        Self {
            blur: blur.then(|| crate::pyramid::Pyramid::new(device, size)),
            glow: glow.then(|| crate::pyramid::Pyramid::new(device, size)),
            input: create(
                "Layer source and backdrop",
                wgpu::TextureFormat::Rgba16Float,
                usage | wgpu::TextureUsages::COPY_DST,
            ),
            output: create(
                "Linear layer output",
                wgpu::TextureFormat::Rgba16Float,
                usage | wgpu::TextureUsages::COPY_SRC,
            ),
            depth: create(
                "Isolated layer depth",
                wgpu::TextureFormat::Depth24Plus,
                wgpu::TextureUsages::RENDER_ATTACHMENT,
            ),
        }
    }
}

impl LayerPipelines {
    pub fn new(device: &wgpu::Device, catalog: &ShaderCatalog) -> Result<Self, RenderError> {
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Backdrop inputs"),
            entries: &[0, 1].map(|binding| wgpu::BindGroupLayoutEntry {
                binding,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            }),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Backdrop layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let program = catalog.program("layer-composite")?;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared backdrop blend"),
            source: wgpu::ShaderSource::Wgsl(program.source.clone().into()),
        });
        let mut pipelines = BTreeMap::new();
        for mode in [2, 4, 5, 6, 7, 8, 9, 10, 11, 12] {
            let constants = program
                .pipeline_constants(&BTreeMap::from([("blend_mode".into(), f64::from(mode))]))?;
            let constants = constants
                .iter()
                .map(|(key, value)| (key.as_str(), *value))
                .collect::<Vec<_>>();
            pipelines.insert(
                mode,
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("Alpha-correct backdrop blend"),
                    layout: Some(&pipeline_layout),
                    vertex: wgpu::VertexState {
                        module: &module,
                        entry_point: Some("vertex_main"),
                        compilation_options: Default::default(),
                        buffers: &[],
                    },
                    fragment: Some(wgpu::FragmentState {
                        module: &module,
                        entry_point: Some("fragment_main"),
                        compilation_options: wgpu::PipelineCompilationOptions {
                            constants: &constants,
                            ..Default::default()
                        },
                        targets: &[Some(wgpu::ColorTargetState {
                            format: wgpu::TextureFormat::Rgba16Float,
                            blend: None,
                            write_mask: wgpu::ColorWrites::ALL,
                        })],
                    }),
                    primitive: Default::default(),
                    depth_stencil: None,
                    multisample: Default::default(),
                    multiview_mask: None,
                    cache: None,
                }),
            );
        }
        Ok(Self {
            pyramids: crate::pyramid::PyramidPipelines::new(device, catalog)?,
            layout,
            pipelines,
            fixed: crate::fixed_composite::FixedComposite::new(device, catalog)?,
        })
    }

    pub fn finish(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        plan: &LayerPlan,
        targets: &LayerTargets,
        output: &OutputPipelines,
        scene: &wgpu::Texture,
    ) -> Result<(), RenderError> {
        let source = targets.input.create_view(&Default::default());
        let effected = targets.output.create_view(&Default::default());
        if plan.composite == aster_render_ir::EffectComposite::Replace {
            if plan.operations.is_empty() {
                return Ok(());
            }
            encoder.copy_texture_to_texture(
                scene.as_image_copy(),
                targets.input.raw().as_image_copy(),
                scene.size(),
            );
        }
        if plan.uses_blur {
            let pyramid = targets
                .blur
                .as_ref()
                .ok_or_else(|| RenderError::Invalid("blur pyramid absent".into()))?;
            self.pyramids
                .record(device, encoder, &source, pyramid, None);
        }
        if plan.uses_glow {
            let pyramid = targets
                .glow
                .as_ref()
                .ok_or_else(|| RenderError::Invalid("glow pyramid absent".into()))?;
            self.pyramids
                .record(device, encoder, &source, pyramid, Some(plan.glow_threshold));
        }
        output.record_layer(
            device,
            encoder,
            plan,
            &source,
            &effected,
            (
                targets.blur.as_ref().map_or(&source, |p| &p.view),
                targets.glow.as_ref().map_or(&source, |p| &p.view),
            ),
        )?;
        if plan.composite == aster_render_ir::EffectComposite::Replace {
            encoder.copy_texture_to_texture(
                targets.output.raw().as_image_copy(),
                scene.as_image_copy(),
                scene.size(),
            );
            return Ok(());
        }
        if plan.composite == aster_render_ir::EffectComposite::Fixed {
            return self.fixed.record(
                device,
                encoder,
                plan.blend,
                &effected,
                &scene.create_view(&Default::default()),
            );
        }
        encoder.copy_texture_to_texture(
            scene.as_image_copy(),
            targets.input.raw().as_image_copy(),
            scene.size(),
        );
        let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Layer and backdrop"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&effected),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&source),
                },
            ],
        });
        let pipeline = self
            .pipelines
            .get(&plan.blend)
            .ok_or_else(|| RenderError::Invalid("missing backdrop pipeline".into()))?;
        let destination = scene.create_view(&Default::default());
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Backdrop composite"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &destination,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &bindings, &[]);
        pass.draw(0..3, 0..1);
        Ok(())
    }
}
