use std::{collections::BTreeMap, time::Duration};

use aster_render_ir::{Extent2d, ResourceHash};
use serde::Serialize;

use crate::{RenderError, layer_key::LayerKey, scene_input::SceneInput};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct LayerCacheStatistics {
    pub allocations: u64,
    pub hits: u64,
    pub misses: u64,
    pub stores: u64,
    pub evictions: u64,
    pub resident_bytes: u64,
    pub active_entries: u64,
}

struct CachedLayer {
    texture: wgpu::Texture,
    valid: bool,
    pending: bool,
    last_used: u64,
}

#[derive(Default)]
pub(crate) struct LayerCache {
    entries: BTreeMap<ResourceHash, CachedLayer>,
    wanted: BTreeMap<ResourceHash, Extent2d>,
    epoch: u64,
    pub generations: BTreeMap<Vec<u16>, ResourceHash>,
    pub statistics: LayerCacheStatistics,
}

impl LayerCache {
    /// Optional entries never reject a valid frame. Retire old allocations before other resource
    /// caches grow; allocate replacements only after those caches have honored this reservation.
    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        scenes: &[&SceneInput],
        generations: BTreeMap<Vec<u16>, ResourceHash>,
        budget: u64,
        timeout: Duration,
    ) -> Result<u64, RenderError> {
        let epoch = self
            .epoch
            .checked_add(1)
            .ok_or_else(|| RenderError::Invalid("layer cache epoch exhausted".into()))?;
        let mut wanted = BTreeMap::new();
        let mut reserved = 0;
        if budget > 0 {
            for scene in scenes {
                let size = scene.header.render_target;
                let bytes = u64::from(size.width) * u64::from(size.height) * 8;
                for key in LayerKey::collect(scene, &generations)?.into_values() {
                    if !wanted.contains_key(&key.hash) && bytes <= budget - reserved {
                        wanted.insert(key.hash, size);
                        reserved += bytes;
                    }
                }
            }
        }
        let active_entries = wanted.len() as u64;
        let mut previous = self
            .entries
            .iter()
            .filter(|(key, entry)| !wanted.contains_key(*key) && entry.valid)
            .map(|(key, entry)| {
                (
                    std::cmp::Reverse(entry.last_used),
                    key.clone(),
                    Extent2d {
                        width: entry.texture.width(),
                        height: entry.texture.height(),
                    },
                )
            })
            .collect::<Vec<_>>();
        previous.sort_by(|left, right| (&left.0, &left.1).cmp(&(&right.0, &right.1)));
        for (_, key, size) in previous {
            let bytes = u64::from(size.width) * u64::from(size.height) * 8;
            if bytes <= budget - reserved {
                wanted.insert(key, size);
                reserved += bytes;
            }
        }
        if self.entries.keys().any(|key| !wanted.contains_key(key)) {
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(timeout),
                })
                .map_err(|error| RenderError::Gpu(error.to_string()))?;
        }
        self.entries.retain(|key, entry| {
            // A discarded command encoder must never publish its pending cache copies.
            entry.pending = false;
            if wanted.contains_key(key) {
                true
            } else {
                self.statistics.evictions += 1;
                self.statistics.resident_bytes -=
                    u64::from(entry.texture.width()) * u64::from(entry.texture.height()) * 8;
                false
            }
        });
        self.wanted = wanted;
        self.epoch = epoch;
        self.generations = generations;
        self.statistics.active_entries = active_entries;
        Ok(reserved)
    }

    pub fn allocate(&mut self, device: &wgpu::Device) {
        for (key, size) in &self.wanted {
            if self.entries.contains_key(key) {
                continue;
            }
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Cached isolated layer output"),
                size: wgpu::Extent3d {
                    width: size.width,
                    height: size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            self.entries.insert(
                key.clone(),
                CachedLayer {
                    texture,
                    valid: false,
                    pending: false,
                    last_used: self.epoch,
                },
            );
            self.statistics.allocations += 1;
            self.statistics.resident_bytes += u64::from(size.width) * u64::from(size.height) * 8;
        }
    }

    pub fn restore(
        &mut self,
        key: &ResourceHash,
        encoder: &mut wgpu::CommandEncoder,
        destination: &wgpu::Texture,
    ) -> bool {
        if let Some(entry) = self.entries.get_mut(key)
            && (entry.valid || entry.pending)
        {
            encoder.copy_texture_to_texture(
                entry.texture.as_image_copy(),
                destination.as_image_copy(),
                destination.size(),
            );
            entry.last_used = self.epoch;
            self.statistics.hits += 1;
            true
        } else {
            self.statistics.misses += 1;
            false
        }
    }

    pub fn store(
        &mut self,
        key: &ResourceHash,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::Texture,
    ) {
        if let Some(entry) = self.entries.get_mut(key) {
            encoder.copy_texture_to_texture(
                source.as_image_copy(),
                entry.texture.as_image_copy(),
                source.size(),
            );
            entry.pending = true;
            entry.last_used = self.epoch;
            self.statistics.stores += 1;
        }
    }

    pub fn commit(&mut self) {
        for entry in self.entries.values_mut() {
            entry.valid |= entry.pending;
            entry.pending = false;
        }
    }

    pub fn invalidate(&mut self) {
        self.entries.clear();
        self.wanted.clear();
        self.generations.clear();
        self.statistics.resident_bytes = 0;
        self.statistics.active_entries = 0;
    }
}
