use std::collections::BTreeMap;

use aster_shaders::ShaderCatalog;

use crate::RenderError;

pub(crate) struct FixedComposite {
    pipelines: BTreeMap<u8, wgpu::RenderPipeline>,
    sampler: wgpu::Sampler,
}

impl FixedComposite {
    pub fn new(device: &wgpu::Device, catalog: &ShaderCatalog) -> Result<Self, RenderError> {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared fixed texture composite"),
            source: wgpu::ShaderSource::Wgsl(
                catalog.program("texture-composite")?.source.clone().into(),
            ),
        });
        let mut pipelines = BTreeMap::new();
        for (mode, destination) in [
            (0, wgpu::BlendFactor::OneMinusSrcAlpha),
            (1, wgpu::BlendFactor::One),
            (3, wgpu::BlendFactor::OneMinusSrc),
        ] {
            pipelines.insert(
                mode,
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("Fixed layer blend"),
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
                            format: wgpu::TextureFormat::Rgba16Float,
                            blend: Some(wgpu::BlendState {
                                color: wgpu::BlendComponent {
                                    src_factor: wgpu::BlendFactor::One,
                                    dst_factor: destination,
                                    operation: wgpu::BlendOperation::Add,
                                },
                                alpha: wgpu::BlendComponent {
                                    src_factor: wgpu::BlendFactor::One,
                                    dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                                    operation: wgpu::BlendOperation::Add,
                                },
                            }),
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
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            min_filter: wgpu::FilterMode::Linear,
            mag_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        Ok(Self { pipelines, sampler })
    }

    pub fn record(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        mode: u8,
        source: &wgpu::TextureView,
        destination: &wgpu::TextureView,
    ) -> Result<(), RenderError> {
        let pipeline = self
            .pipelines
            .get(&mode)
            .ok_or_else(|| RenderError::Invalid("fixed blend pipeline absent".into()))?;
        let binding = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Fixed layer source"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(source),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Fixed layer composite"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: destination,
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
        pass.set_bind_group(0, &binding, &[]);
        pass.draw(0..3, 0..1);
        Ok(())
    }
}
