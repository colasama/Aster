use std::{collections::BTreeMap, time::Duration};

use aster_render_ir::Extent2d;

use crate::{
    RenderError, layers::LayerTargets, pyramid_levels::PyramidLevels, scene_input::SceneInput,
};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct TargetKey {
    width: u32,
    height: u32,
    blur: u32,
    glow: u32,
}

impl TargetKey {
    fn for_scene(scene: &SceneInput) -> Option<Self> {
        let size = scene.header.render_target;
        let levels = scene.pyramid_levels();
        (!scene.layers.is_empty()).then_some(Self {
            width: size.width,
            height: size.height,
            blur: levels.blur,
            glow: levels.glow,
        })
    }
}

/// Scratch attachments only: each layer clears or overwrites them before reading.
/// Sequential scenes may share a slot, but no previous rendered result is reused.
#[derive(Default)]
pub(crate) struct LayerTargetPool {
    entries: BTreeMap<TargetKey, LayerTargets>,
    wanted: BTreeMap<TargetKey, ()>,
    pub allocations: u64,
}

impl LayerTargetPool {
    pub fn resident_bytes(&self) -> u64 {
        self.entries
            .keys()
            .map(|key| {
                let size = Extent2d {
                    width: key.width,
                    height: key.height,
                };
                u64::from(key.width) * u64::from(key.height) * 20
                    + crate::pyramid::Pyramid::bytes(size, key.blur)
                    + crate::pyramid::Pyramid::bytes(size, key.glow)
            })
            .sum()
    }

    /// Retire before other frame allocations grow. Unique slots cost no more than the
    /// per-scene transient attachments already included in the frame's GPU budget.
    pub fn retire(
        &mut self,
        device: &wgpu::Device,
        scenes: &[&SceneInput],
        timeout: Duration,
    ) -> Result<(), RenderError> {
        self.wanted = scenes
            .iter()
            .filter_map(|scene| TargetKey::for_scene(scene).map(|key| (key, ())))
            .collect();
        if self
            .entries
            .keys()
            .any(|key| !self.wanted.contains_key(key))
        {
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(timeout),
                })
                .map_err(|error| RenderError::Gpu(error.to_string()))?;
            self.entries.retain(|key, _| self.wanted.contains_key(key));
        }
        Ok(())
    }

    pub fn allocate(&mut self, device: &wgpu::Device) {
        for key in self.wanted.keys() {
            if let std::collections::btree_map::Entry::Vacant(entry) = self.entries.entry(*key) {
                entry.insert(LayerTargets::new(
                    device,
                    Extent2d {
                        width: key.width,
                        height: key.height,
                    },
                    PyramidLevels {
                        blur: key.blur,
                        glow: key.glow,
                    },
                ));
                self.allocations += 1;
            }
        }
    }

    pub fn get(&self, scene: &SceneInput) -> Result<Option<&LayerTargets>, RenderError> {
        TargetKey::for_scene(scene)
            .map(|key| {
                self.entries.get(&key).ok_or_else(|| {
                    RenderError::Invalid("layer scratch attachments were not prepared".into())
                })
            })
            .transpose()
    }
}
