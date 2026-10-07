use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

use aster_render_ir::{ResourceHash, ResourceRegistry};
use serde::Serialize;

use crate::{RenderError, image_input::ImageInput};

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize)]
pub struct ImageCacheStatistics {
    pub uploads: u64,
    pub hits: u64,
    pub evictions: u64,
    pub resident_bytes: u64,
}

type ImageKey = (ResourceHash, ResourceHash);

struct CachedImage {
    _texture: wgpu::Texture,
    binding: wgpu::BindGroup,
    bytes: u64,
    last_used: u64,
}

pub(crate) struct ImageCache {
    pub layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    entries: BTreeMap<ImageKey, CachedImage>,
    derived: BTreeMap<ImageKey, wgpu::BindGroup>,
    epoch: u64,
    pub statistics: ImageCacheStatistics,
}

impl ImageCache {
    pub fn new(device: &wgpu::Device) -> Self {
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Native image bindings"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        Self {
            layout,
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                min_filter: wgpu::FilterMode::Linear,
                mag_filter: wgpu::FilterMode::Linear,
                mipmap_filter: wgpu::MipmapFilterMode::Linear,
                ..Default::default()
            }),
            entries: BTreeMap::new(),
            derived: BTreeMap::new(),
            epoch: 0,
            statistics: ImageCacheStatistics::default(),
        }
    }

    /// Admit the entire frame before eviction or allocation; required generations cannot be evicted.
    pub fn prepare(
        &mut self,
        gpu: (&wgpu::Device, &wgpu::Queue),
        inputs: &BTreeMap<ResourceHash, ImageInput>,
        registry: &ResourceRegistry,
        budget: u64,
        timeout: Duration,
    ) -> Result<(), RenderError> {
        let (device, queue) = gpu;
        let epoch = self
            .epoch
            .checked_add(1)
            .ok_or_else(|| RenderError::Invalid("image cache epoch exhausted".into()))?;
        let mut required = BTreeSet::new();
        let mut requested = 0_u64;
        let mut missing = 0_u64;
        for input in inputs.values() {
            let bytes = u64::from(input.width)
                * u64::from(input.height)
                * u64::from(input.format.bytes_per_pixel());
            if input.width > device.limits().max_texture_dimension_2d
                || input.height > device.limits().max_texture_dimension_2d
                || registry.resolve(&input.pixels)?.len() as u64 != bytes
            {
                return Err(RenderError::Invalid(
                    "image exceeds device extent or payload length".into(),
                ));
            }
            let key = (input.frame.clone(), input.pixels.clone());
            if required.insert(key.clone()) {
                requested = requested
                    .checked_add(bytes)
                    .ok_or_else(|| RenderError::Invalid("image cache byte overflow".into()))?;
                if !self.entries.contains_key(&key) {
                    missing += bytes;
                }
            }
        }
        if requested > budget {
            return Err(RenderError::Invalid(
                "images exceed GPU allocation budget".into(),
            ));
        }
        let mut total = self.statistics.resident_bytes + missing;
        let mut candidates = self
            .entries
            .iter()
            .filter(|(key, _)| !required.contains(*key))
            .map(|(key, value)| (value.last_used, key.clone(), value.bytes))
            .collect::<Vec<_>>();
        candidates.sort();
        let mut victims = Vec::new();
        for (_, key, bytes) in candidates {
            if total <= budget {
                break;
            }
            victims.push(key);
            total -= bytes;
        }
        if !victims.is_empty() {
            // Waiting only under pressure lets retired GPU objects actually leave the byte budget.
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(timeout),
                })
                .map_err(|e| RenderError::Gpu(e.to_string()))?;
        }
        for key in victims {
            if let Some(value) = self.entries.remove(&key) {
                self.statistics.resident_bytes -= value.bytes;
                self.statistics.evictions += 1;
            }
        }
        self.epoch = epoch;
        for input in inputs.values() {
            let key = (input.frame.clone(), input.pixels.clone());
            if let Some(existing) = self.entries.get_mut(&key) {
                existing.last_used = epoch;
                self.statistics.hits += 1;
                continue;
            }
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Cached native still image"),
                size: wgpu::Extent3d {
                    width: input.width,
                    height: input.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: match input.format {
                    aster_render_ir::MediaTextureFormat::Rgba8UnormSrgb => {
                        wgpu::TextureFormat::Rgba8UnormSrgb
                    }
                    aster_render_ir::MediaTextureFormat::Rgba16Float => {
                        wgpu::TextureFormat::Rgba16Float
                    }
                },
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            queue.write_texture(
                texture.as_image_copy(),
                registry.resolve(&input.pixels)?,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(input.width * input.format.bytes_per_pixel()),
                    rows_per_image: Some(input.height),
                },
                texture.size(),
            );
            let view = texture.create_view(&Default::default());
            let binding = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Cached native image"),
                layout: &self.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                ],
            });
            let bytes = u64::from(input.width)
                * u64::from(input.height)
                * u64::from(input.format.bytes_per_pixel());
            self.entries.insert(
                key,
                CachedImage {
                    _texture: texture,
                    binding,
                    bytes,
                    last_used: epoch,
                },
            );
            self.statistics.uploads += 1;
            self.statistics.resident_bytes += bytes;
        }
        Ok(())
    }

    pub fn binding(&self, image: &ImageInput) -> Result<&wgpu::BindGroup, RenderError> {
        if let Some(binding) = self
            .derived
            .get(&(image.frame.clone(), image.pixels.clone()))
        {
            return Ok(binding);
        }
        self.entries
            .get(&(image.frame.clone(), image.pixels.clone()))
            .map(|entry| &entry.binding)
            .ok_or_else(|| RenderError::Invalid("image generation absent from GPU cache".into()))
    }

    pub fn invalidate(&mut self) {
        self.derived.clear();
        self.statistics.evictions += self.entries.len() as u64;
        self.entries.clear();
        self.statistics.resident_bytes = 0;
    }

    pub fn texture(&self, image: &ImageInput) -> Result<&wgpu::Texture, RenderError> {
        self.entries
            .get(&(image.frame.clone(), image.pixels.clone()))
            .map(|entry| &entry._texture)
            .ok_or_else(|| RenderError::Invalid("sample generation absent from GPU cache".into()))
    }

    pub fn install_derived(
        &mut self,
        device: &wgpu::Device,
        inputs: Vec<(ResourceHash, ResourceHash, wgpu::Texture)>,
    ) {
        self.derived.clear();
        for (frame, generation, texture) in inputs {
            let binding = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Derived raster scene binding"),
                layout: &self.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(
                            &texture.create_view(&Default::default()),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                ],
            });
            self.derived.insert((frame, generation), binding);
        }
    }
}
