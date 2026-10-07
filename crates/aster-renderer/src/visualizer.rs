use crate::{AuxiliaryPrimaryPipelines, AuxiliaryPrimaryTargets, RenderError, SuppliedFrame};
use wgpu::util::DeviceExt;

pub(crate) struct Visualizer {
    auxiliary: AuxiliaryPrimaryPipelines,
    pipelines: Vec<wgpu::RenderPipeline>,
}

impl Visualizer {
    pub fn new(device: &wgpu::Device, layout: &wgpu::BindGroupLayout) -> Result<Self, RenderError> {
        let catalog = aster_shaders::ShaderCatalog::embedded()?;
        let mut pipelines = Vec::new();
        for name in ["diagnostic-scene", "diagnostic-float", "diagnostic-uint"] {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(name),
                source: wgpu::ShaderSource::Wgsl(catalog.program(name)?.source.clone().into()),
            });
            pipelines.push(
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("Native buffer visualization"),
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
                }),
            );
        }
        Ok(Self {
            auxiliary: AuxiliaryPrimaryPipelines::new(device, &catalog, layout)?,
            pipelines,
        })
    }

    pub fn record(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        frame: &SuppliedFrame,
        textures: (&wgpu::Texture, &wgpu::Texture),
        caches: (
            &crate::image_cache::ImageCache,
            &crate::surface_cache::SurfaceCache,
            &std::collections::BTreeMap<Vec<u16>, crate::AuxiliaryGeneratorDraw>,
        ),
    ) -> Result<(), RenderError> {
        let plan = frame
            .visualizer
            .as_ref()
            .ok_or_else(|| RenderError::Invalid("visualizer plan absent".into()))?;
        let targets = if let Some(auxiliary) = &plan.auxiliary {
            let targets =
                AuxiliaryPrimaryTargets::new(device, auxiliary, auxiliary.required_bytes())?;
            let bindings = auxiliary.bindings(frame, (caches.0, caches.1))?;
            self.auxiliary.record(
                device,
                encoder,
                auxiliary,
                &targets,
                (
                    &bindings.iter().map(Option::as_ref).collect::<Vec<_>>(),
                    caches.2,
                ),
            )?;
            Some(targets)
        } else {
            None
        };
        let source = if let Some(index) = plan.attachment {
            targets
                .as_ref()
                .and_then(|t| t.colors.get(index))
                .ok_or_else(|| RenderError::Invalid("visualizer attachment absent".into()))?
        } else {
            textures.0
        };
        let source = source.create_view(&Default::default());
        let uniforms = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Supplied visualization controls"),
            contents: &plan.uniforms,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let pipeline = &self.pipelines[plan.pipeline];
        let mut entries = vec![wgpu::BindGroupEntry {
            binding: 0,
            resource: wgpu::BindingResource::TextureView(&source),
        }];
        if plan.pipeline != 2 {
            entries.push(wgpu::BindGroupEntry {
                binding: 1,
                resource: uniforms.as_entire_binding(),
            });
        }
        let binding = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Supplied visualization source"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &entries,
        });
        let view = textures.1.create_view(&Default::default());
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Native buffer view"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(frame.output_clear),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &binding, &[]);
        pass.draw(0..3, 0..1);
        Ok(())
    }
}
