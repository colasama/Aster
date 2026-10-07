use std::collections::BTreeMap;

use wgpu::util::DeviceExt;

use crate::{RenderError, image_cache::ImageCache, scene_input::SceneInput};

pub(crate) struct MaterialPipelines {
    layout: wgpu::BindGroupLayout,
    pub pipelines: BTreeMap<u8, wgpu::RenderPipeline>,
    normal: wgpu::TextureView,
    environment: wgpu::TextureView,
    normal_sampler: wgpu::Sampler,
    environment_sampler: wgpu::Sampler,
}

impl MaterialPipelines {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        catalog: &aster_shaders::ShaderCatalog,
        lighting: &wgpu::BindGroupLayout,
    ) -> Result<Self, RenderError> {
        let mut entries = Vec::new();
        for binding in 0..5 {
            entries.push(wgpu::BindGroupLayoutEntry {
                binding,
                visibility: wgpu::ShaderStages::FRAGMENT,
                count: None,
                ty: match binding {
                    0 | 1 => wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    2 | 3 => wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    _ => wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                },
            });
        }
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Native material textures"),
            entries: &entries,
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared material shape"),
            source: wgpu::ShaderSource::Wgsl(
                catalog
                    .program("scene-material-shape")?
                    .source
                    .clone()
                    .into(),
            ),
        });
        let pipelines = crate::geometry_pipelines::GeometryPipelines::create(
            device,
            &module,
            &[Some(lighting), Some(&layout)],
        );
        let mut fallbacks = Vec::new();
        for (format, bytes) in [
            (wgpu::TextureFormat::Rgba8Unorm, vec![128, 128, 255, 255]),
            (
                wgpu::TextureFormat::Rgba16Float,
                vec![0, 0, 0, 0, 0, 0, 0, 60],
            ),
        ] {
            let texture = device.create_texture_with_data(
                queue,
                &wgpu::TextureDescriptor {
                    label: Some("Native material fallback"),
                    size: wgpu::Extent3d {
                        width: 1,
                        height: 1,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                },
                wgpu::util::TextureDataOrder::LayerMajor,
                &bytes,
            );
            fallbacks.push(texture.create_view(&Default::default()));
        }
        let sampler = wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::Repeat,
            min_filter: wgpu::FilterMode::Linear,
            mag_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        };
        Ok(Self {
            pipelines,
            layout,
            normal: fallbacks.remove(0),
            environment: fallbacks.remove(0),
            normal_sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                address_mode_v: wgpu::AddressMode::Repeat,
                ..sampler.clone()
            }),
            environment_sampler: device.create_sampler(&sampler),
        })
    }

    pub fn bindings(
        &self,
        device: &wgpu::Device,
        scene: &SceneInput,
        images: &ImageCache,
    ) -> Result<BTreeMap<u32, wgpu::BindGroup>, RenderError> {
        let mut bindings = BTreeMap::new();
        for (index, material) in &scene.materials {
            if !material.active {
                continue;
            }
            let environment = material
                .environment
                .as_ref()
                .map(|image| {
                    images
                        .texture(image)
                        .map(|t| t.create_view(&Default::default()))
                })
                .transpose()?;
            let normal = material
                .normal
                .as_ref()
                .map(|image| {
                    images
                        .texture(image)
                        .map(|t| t.create_view(&Default::default()))
                })
                .transpose()?;
            let uniforms = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Supplied material controls"),
                contents: &material.uniforms,
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let entries = [
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(
                        normal.as_ref().map_or(&self.normal, |view| view),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        environment.as_ref().map_or(&self.environment, |view| view),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.normal_sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(&self.environment_sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: uniforms.as_entire_binding(),
                },
            ];
            bindings.insert(
                *index,
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Supplied material resources"),
                    layout: &self.layout,
                    entries: &entries,
                }),
            );
        }
        Ok(bindings)
    }
}
