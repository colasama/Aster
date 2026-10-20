use crate::{RenderError, surface_plan::SurfacePlan};
use aster_render_ir::{CompositionIdentity, Extent2d};
use serde::Serialize;
use std::{collections::BTreeMap, time::Duration};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct SurfaceCacheStatistics {
    pub allocations: u64,
    pub hits: u64,
    pub reuses: u64,
    pub evictions: u64,
    pub resident_bytes: u64,
}

pub(crate) struct SurfaceExtent {
    pub key: Vec<u16>,
    pub size: Extent2d,
}

pub(crate) struct SurfaceTarget {
    pub color: wgpu::Texture,
    pub depth: wgpu::TextureView,
    pub binding: wgpu::BindGroup,
    size: Extent2d,
}

#[derive(Default)]
pub(crate) struct SurfaceCache {
    entries: BTreeMap<Vec<u16>, SurfaceTarget>,
    pub statistics: SurfaceCacheStatistics,
}

impl SurfaceCache {
    /// Admission precedes mutation. Only allocation is cached; every admitted scene is rendered anew.
    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        plan: &SurfacePlan,
        budget: u64,
        timeout: Duration,
    ) -> Result<(), RenderError> {
        let targets = plan
            .targets
            .iter()
            .map(|target| SurfaceExtent {
                key: target.key.clone(),
                size: target.size,
            })
            .collect::<Vec<_>>();
        self.prepare_extents(device, layout, &targets, budget, timeout)
    }

    pub fn prepare_extents(
        &mut self,
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        targets: &[SurfaceExtent],
        budget: u64,
        timeout: Duration,
    ) -> Result<(), RenderError> {
        let bytes = targets
            .iter()
            .map(|t| u64::from(t.size.width) * u64::from(t.size.height) * 12)
            .sum::<u64>();
        if bytes > budget
            || targets.iter().any(|t| {
                t.size.width == 0
                    || t.size.height == 0
                    || t.size.width > device.limits().max_texture_dimension_2d
                    || t.size.height > device.limits().max_texture_dimension_2d
            })
        {
            return Err(RenderError::Invalid(
                "surfaces exceed GPU allocation budget or dimensions".into(),
            ));
        }
        // Retiring old generations must not overlap their physical allocations with the new budget.
        if !self.entries.is_empty()
            && (self.entries.len() != targets.len()
                || targets.iter().any(|t| {
                    self.entries
                        .get(&t.key)
                        .is_none_or(|old| old.size != t.size)
                }))
        {
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(timeout),
                })
                .map_err(|error| RenderError::Gpu(error.to_string()))?;
        }
        let mut pool = std::mem::take(&mut self.entries);
        let mut entries = BTreeMap::new();
        // Reserve exact matches before reassigning unused compatible allocations.
        for target in targets {
            if pool
                .get(&target.key)
                .is_some_and(|old| old.size == target.size)
                && let Some(old) = pool.remove(&target.key)
            {
                entries.insert(target.key.clone(), old);
                self.statistics.hits += 1;
            }
        }
        let mut missing = Vec::new();
        for target in targets {
            if entries.contains_key(&target.key) {
                continue;
            }
            let reusable = pool
                .iter()
                .find(|(_, old)| old.size == target.size)
                .map(|(key, _)| key.clone());
            if let Some(key) = reusable {
                if let Some(old) = pool.remove(&key) {
                    entries.insert(target.key.clone(), old);
                    self.statistics.reuses += 1;
                }
            } else {
                missing.push(target);
            }
        }
        self.statistics.evictions += pool.len() as u64;
        drop(pool);
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            min_filter: wgpu::FilterMode::Linear,
            mag_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        for target in missing {
            let size = wgpu::Extent3d {
                width: target.size.width,
                height: target.size.height,
                depth_or_array_layers: 1,
            };
            let color = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Cached linear precomposition"),
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC
                    | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let depth = device
                .create_texture(&wgpu::TextureDescriptor {
                    label: Some("Cached precomposition depth"),
                    size,
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Depth24Plus,
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                    view_formats: &[],
                })
                .create_view(&Default::default());
            let binding = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Premultiplied precomposition input"),
                layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(
                            &color.create_view(&Default::default()),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&sampler),
                    },
                ],
            });
            entries.insert(
                target.key.clone(),
                SurfaceTarget {
                    color,
                    depth,
                    binding,
                    size: target.size,
                },
            );
            self.statistics.allocations += 1;
        }
        self.entries = entries;
        self.statistics.resident_bytes = bytes;
        Ok(())
    }

    pub fn target(&self, key: &[u16]) -> Result<&SurfaceTarget, RenderError> {
        self.entries
            .get(key)
            .ok_or_else(|| RenderError::Invalid("surface target absent".into()))
    }

    pub fn binding(
        &self,
        plan: &SurfacePlan,
        id: &CompositionIdentity,
    ) -> Result<&wgpu::BindGroup, RenderError> {
        let index = plan
            .bindings
            .get(&SurfacePlan::key(id))
            .ok_or_else(|| RenderError::Invalid("surface alias absent".into()))?;
        let target = plan
            .targets
            .get(*index)
            .ok_or_else(|| RenderError::Invalid("surface alias out of range".into()))?;
        Ok(&self.target(&target.key)?.binding)
    }

    pub fn invalidate(&mut self) {
        self.entries.clear();
        self.statistics.resident_bytes = 0;
    }
}
