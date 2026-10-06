use std::{collections::BTreeMap, time::Duration};

use aster_render_ir::{
    ResourceDescriptor, ResourceHash, ResourceRegistry, TextureDimension, TexturePixelFormat,
    TexturePixelsDescriptor,
};
use serde::Serialize;

use crate::RenderError;

#[derive(Clone)]
pub(crate) struct LutInput {
    pub descriptor: TexturePixelsDescriptor,
    pub bytes: u64,
}

impl LutInput {
    pub fn new(hash: &ResourceHash, registry: &ResourceRegistry) -> Result<Self, RenderError> {
        let ResourceDescriptor::TexturePixels(descriptor) = registry.descriptor(hash)? else {
            return Err(RenderError::Invalid(
                "LUT requires packed texture pixels".into(),
            ));
        };
        let bytes = registry.resolve(hash)?;
        descriptor.validate(bytes)?;
        if descriptor.dimension != TextureDimension::D3
            || descriptor.width < 2
            || descriptor.width != descriptor.height
            || descriptor.width != descriptor.depth
        {
            return Err(RenderError::Invalid(
                "LUT requires a cubic 3D texture".into(),
            ));
        }
        if descriptor.format == TexturePixelFormat::Rgba16Float
            && bytes
                .chunks_exact(2)
                .any(|lane| u16::from_le_bytes([lane[0], lane[1]]) & 0x7c00 == 0x7c00)
        {
            return Err(RenderError::Invalid(
                "LUT contains non-finite samples".into(),
            ));
        }
        Ok(Self {
            descriptor: descriptor.clone(),
            bytes: bytes.len() as u64,
        })
    }
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize)]
pub struct LutCacheStatistics {
    pub uploads: u64,
    pub hits: u64,
    pub evictions: u64,
    pub resident_bytes: u64,
}

struct CachedLut {
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
    bytes: u64,
    last_used: u64,
}

#[derive(Default)]
pub(crate) struct LutCache {
    entries: BTreeMap<ResourceHash, CachedLut>,
    epoch: u64,
    pub statistics: LutCacheStatistics,
}

impl LutCache {
    /// Validate the entire demand before replacing any live allocation.
    pub fn prepare(
        &mut self,
        gpu: (&wgpu::Device, &wgpu::Queue),
        inputs: &BTreeMap<ResourceHash, LutInput>,
        registry: &ResourceRegistry,
        budget: u64,
        timeout: Duration,
    ) -> Result<(), RenderError> {
        let (device, queue) = gpu;
        let epoch = self
            .epoch
            .checked_add(1)
            .ok_or_else(|| RenderError::Invalid("LUT cache epoch exhausted".into()))?;
        let mut required = 0_u64;
        let mut missing = 0_u64;
        for (hash, input) in inputs {
            let checked = LutInput::new(hash, registry)?;
            if checked.descriptor != input.descriptor
                || checked.bytes != input.bytes
                || input.descriptor.width > device.limits().max_texture_dimension_3d
            {
                return Err(RenderError::Invalid(
                    "LUT exceeds GPU dimensions or input differs".into(),
                ));
            }
            required = required
                .checked_add(input.bytes)
                .ok_or_else(|| RenderError::Invalid("LUT byte overflow".into()))?;
            if !self.entries.contains_key(hash) {
                missing += input.bytes;
            }
        }
        if required > budget {
            return Err(RenderError::Invalid(
                "LUTs exceed GPU allocation budget".into(),
            ));
        }
        let mut total = self.statistics.resident_bytes + missing;
        let mut candidates = self
            .entries
            .iter()
            .filter(|(key, _)| !inputs.contains_key(*key))
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
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(timeout),
                })
                .map_err(|error| RenderError::Gpu(error.to_string()))?;
        }
        for key in victims {
            if let Some(value) = self.entries.remove(&key) {
                self.statistics.resident_bytes -= value.bytes;
                self.statistics.evictions += 1;
            }
        }
        self.epoch = epoch;
        for (hash, input) in inputs {
            if let Some(entry) = self.entries.get_mut(hash) {
                entry.last_used = epoch;
                self.statistics.hits += 1;
                continue;
            }
            let descriptor = &input.descriptor;
            let (format, texel) = match descriptor.format {
                TexturePixelFormat::Rgba8Unorm => (wgpu::TextureFormat::Rgba8Unorm, 4),
                TexturePixelFormat::Rgba16Float => (wgpu::TextureFormat::Rgba16Float, 8),
            };
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Content-addressed 3D LUT"),
                size: wgpu::Extent3d {
                    width: descriptor.width,
                    height: descriptor.height,
                    depth_or_array_layers: descriptor.depth,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D3,
                format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_DST
                    | if cfg!(test) {
                        wgpu::TextureUsages::COPY_SRC
                    } else {
                        wgpu::TextureUsages::empty()
                    },
                view_formats: &[],
            });
            queue.write_texture(
                texture.as_image_copy(),
                registry.resolve(hash)?,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(descriptor.width * texel),
                    rows_per_image: Some(descriptor.height),
                },
                texture.size(),
            );
            let view = texture.create_view(&Default::default());
            self.entries.insert(
                hash.clone(),
                CachedLut {
                    _texture: texture,
                    view,
                    bytes: input.bytes,
                    last_used: epoch,
                },
            );
            self.statistics.uploads += 1;
            self.statistics.resident_bytes += input.bytes;
        }
        Ok(())
    }

    pub fn view(&self, hash: &ResourceHash) -> Result<&wgpu::TextureView, RenderError> {
        self.entries
            .get(hash)
            .map(|entry| &entry.view)
            .ok_or_else(|| RenderError::Invalid("LUT absent from GPU cache".into()))
    }

    pub fn invalidate(&mut self) {
        self.statistics.evictions += self.entries.len() as u64;
        self.entries.clear();
        self.statistics.resident_bytes = 0;
    }
}

#[cfg(test)]
#[path = "lut_cache_tests.rs"]
mod tests;
