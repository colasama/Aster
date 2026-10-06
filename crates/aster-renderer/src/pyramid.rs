use crate::RenderError;
use aster_render_ir::Extent2d;
use aster_shaders::ShaderCatalog;
use wgpu::util::DeviceExt;

pub(crate) struct Pyramid {
    pub view: wgpu::TextureView,
    levels: Vec<wgpu::TextureView>,
}

impl Pyramid {
    pub fn new(device: &wgpu::Device, size: Extent2d) -> Self {
        let width = size.width.div_ceil(2).max(1);
        let height = size.height.div_ceil(2).max(1);
        let count = (width.max(height).ilog2() + 1).min(8);
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Linear layer pyramid"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: count,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        Self {
            view: texture.create_view(&Default::default()),
            levels: (0..count)
                .map(|level| {
                    texture.create_view(&wgpu::TextureViewDescriptor {
                        base_mip_level: level,
                        mip_level_count: Some(1),
                        ..Default::default()
                    })
                })
                .collect(),
        }
    }

    pub fn bytes(size: Extent2d) -> u64 {
        let width = size.width.div_ceil(2).max(1);
        let height = size.height.div_ceil(2).max(1);
        (0..(width.max(height).ilog2() + 1).min(8))
            .map(|level| {
                u64::from((width >> level).max(1)) * u64::from((height >> level).max(1)) * 8
            })
            .sum()
    }
}

pub(crate) struct PyramidPipelines {
    blur: wgpu::RenderPipeline,
    bright: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
}

impl PyramidPipelines {
    pub fn new(device: &wgpu::Device, catalog: &ShaderCatalog) -> Result<Self, RenderError> {
        let create = |name: &str| -> Result<wgpu::RenderPipeline, RenderError> {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(name),
                source: wgpu::ShaderSource::Wgsl(catalog.program(name)?.source.clone().into()),
            });
            Ok(
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(name),
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
            )
        };
        Ok(Self {
            blur: create("blur-downsample")?,
            bright: create("brightpass-downsample")?,
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                min_filter: wgpu::FilterMode::Linear,
                mag_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
        })
    }

    pub fn record(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::TextureView,
        pyramid: &Pyramid,
        threshold: Option<f32>,
    ) {
        let mut bytes = [0_u8; 32];
        bytes[..4].copy_from_slice(&threshold.map_or(0.0, |value| value).to_le_bytes());
        let parameters = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Immutable brightpass threshold"),
            contents: &bytes,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        for (level, view) in pyramid.levels.iter().enumerate() {
            let bright = level == 0 && threshold.is_some();
            let pipeline = if bright { &self.bright } else { &self.blur };
            let mut entries = vec![
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(if level == 0 {
                        source
                    } else {
                        &pyramid.levels[level - 1]
                    }),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ];
            if bright {
                entries.push(wgpu::BindGroupEntry {
                    binding: 2,
                    resource: parameters.as_entire_binding(),
                });
            }
            let binding = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Pyramid source level"),
                layout: &pipeline.get_bind_group_layout(0),
                entries: &entries,
            });
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Linear pyramid downsample"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &binding, &[]);
            pass.draw(0..3, 0..1);
        }
    }
}
