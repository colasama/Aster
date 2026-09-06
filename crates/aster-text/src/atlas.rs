use std::{collections::BTreeMap, ops::Range};

use crate::{CacheError, GlyphBitmap, GlyphKey, GlyphMetrics};

#[derive(Clone, Copy, Debug, Eq, PartialEq, clap::Args)]
pub struct AtlasLimits {
    #[arg(long, default_value_t = Self::default().max_atlas_dimension)]
    pub max_atlas_dimension: u32,
    #[arg(long, default_value_t = Self::default().max_atlas_layers)]
    pub max_atlas_layers: u32,
    #[arg(long, default_value_t = Self::default().max_atlas_glyphs)]
    pub max_atlas_glyphs: usize,
}
impl Default for AtlasLimits {
    fn default() -> Self {
        Self {
            max_atlas_dimension: 8_192,
            max_atlas_layers: 256,
            max_atlas_glyphs: 1_048_576,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AtlasFormat {
    R8Unorm,
}

impl AtlasFormat {
    const fn bytes_per_pixel(self) -> u32 {
        match self {
            Self::R8Unorm => 1,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, clap::Args)]
pub struct AtlasConfig {
    #[command(flatten)]
    pub limits: AtlasLimits,
    #[arg(long = "atlas-width", default_value_t = Self::default().width)]
    pub width: u32,
    #[arg(long = "atlas-height", default_value_t = Self::default().height)]
    pub height: u32,
    #[arg(long = "atlas-layers", default_value_t = Self::default().layers)]
    pub layers: u32,
    #[arg(long = "atlas-padding", default_value_t = Self::default().padding)]
    pub padding: u32,
    #[arg(long = "atlas-row-alignment", default_value_t = Self::default().row_alignment)]
    pub row_alignment: u32,
    #[arg(long = "atlas-max-glyphs", default_value_t = Self::default().max_glyphs)]
    pub max_glyphs: usize,
}

impl Default for AtlasConfig {
    fn default() -> Self {
        Self {
            limits: AtlasLimits::default(),
            width: 2048,
            height: 2048,
            layers: 2,
            padding: 1,
            row_alignment: 256,
            max_glyphs: 16_384,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GlyphAtlasDescriptor {
    pub width: u32,
    pub height: u32,
    pub layers: u32,
    pub format: AtlasFormat,
    /// Aligned byte pitch for whole-layer copies or readbacks.
    pub aligned_bytes_per_row: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AtlasRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlyphAtlasEntry {
    pub layer: u32,
    pub rect: AtlasRect,
    pub metrics: GlyphMetrics,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlyphUpload {
    pub layer: u32,
    pub origin: [u32; 3],
    pub extent: [u32; 3],
    pub bytes_per_row: u32,
    /// Coverage with each row padded to `bytes_per_row` for direct GPU upload.
    pub data: Vec<u8>,
}

#[derive(Debug)]
struct Shelf {
    y: u32,
    height: u32,
    free: Vec<Range<u32>>,
}

#[derive(Clone, Copy, Debug)]
struct Allocation {
    layer: u32,
    shelf: usize,
    outer_x: u32,
    outer_width: u32,
}

#[derive(Clone, Copy, Debug)]
struct Entry {
    atlas: GlyphAtlasEntry,
    allocation: Allocation,
    last_used: u64,
}

pub struct GlyphAtlas {
    config: AtlasConfig,
    descriptor: GlyphAtlasDescriptor,
    shelves: Vec<Vec<Shelf>>,
    entries: BTreeMap<GlyphKey, Entry>,
    clock: u64,
    evictions: u64,
}

impl GlyphAtlas {
    pub fn new(config: AtlasConfig) -> Result<Self, CacheError> {
        if config.width == 0 || config.height == 0 || config.layers == 0 {
            return Err(CacheError::InvalidAtlasConfig(
                "width, height, and layers must be non-zero",
            ));
        }
        if config.width > config.limits.max_atlas_dimension
            || config.height > config.limits.max_atlas_dimension
            || config.layers > config.limits.max_atlas_layers
        {
            return Err(CacheError::InvalidAtlasConfig(
                "atlas dimensions or layer count exceed safety limits",
            ));
        }
        if config.max_glyphs == 0 || config.max_glyphs > config.limits.max_atlas_glyphs {
            return Err(CacheError::InvalidAtlasConfig(
                "max_glyphs is outside safety limits",
            ));
        }
        if !config.row_alignment.is_power_of_two() || config.row_alignment > 4_096 {
            return Err(CacheError::InvalidAtlasConfig(
                "row_alignment must be a power of two up to 4096",
            ));
        }
        if config.padding > 1_024 {
            return Err(CacheError::InvalidAtlasConfig(
                "padding exceeds safety limits",
            ));
        }
        let format = AtlasFormat::R8Unorm;
        let tight_pitch = config
            .width
            .checked_mul(format.bytes_per_pixel())
            .ok_or(CacheError::InvalidAtlasConfig("row pitch overflow"))?;
        let aligned_bytes_per_row = AtlasConfig::align_up(tight_pitch, config.row_alignment)
            .ok_or(CacheError::InvalidAtlasConfig("aligned row pitch overflow"))?;
        let layers = usize::try_from(config.layers)
            .map_err(|_| CacheError::InvalidAtlasConfig("layer count exceeds address space"))?;
        Ok(Self {
            config,
            descriptor: GlyphAtlasDescriptor {
                width: config.width,
                height: config.height,
                layers: config.layers,
                format,
                aligned_bytes_per_row,
            },
            shelves: (0..layers).map(|_| Vec::new()).collect(),
            entries: BTreeMap::new(),
            clock: 0,
            evictions: 0,
        })
    }

    #[must_use]
    pub const fn descriptor(&self) -> GlyphAtlasDescriptor {
        self.descriptor
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    #[must_use]
    pub const fn evictions(&self) -> u64 {
        self.evictions
    }

    pub fn get(&mut self, key: GlyphKey) -> Option<GlyphAtlasEntry> {
        self.clock = self.clock.saturating_add(1);
        self.entries.get_mut(&key).map(|entry| {
            entry.last_used = self.clock;
            entry.atlas
        })
    }

    pub fn insert(
        &mut self,
        key: GlyphKey,
        glyph: &GlyphBitmap,
    ) -> Result<(GlyphAtlasEntry, GlyphUpload), CacheError> {
        glyph.validate()?;
        let double_padding =
            self.config
                .padding
                .checked_mul(2)
                .ok_or(CacheError::GlyphTooLarge {
                    width: glyph.width,
                    height: glyph.height,
                })?;
        let outer_width =
            glyph
                .width
                .checked_add(double_padding)
                .ok_or(CacheError::GlyphTooLarge {
                    width: glyph.width,
                    height: glyph.height,
                })?;
        let outer_height =
            glyph
                .height
                .checked_add(double_padding)
                .ok_or(CacheError::GlyphTooLarge {
                    width: glyph.width,
                    height: glyph.height,
                })?;
        if outer_width > self.config.width || outer_height > self.config.height {
            return Err(CacheError::GlyphTooLarge {
                width: glyph.width,
                height: glyph.height,
            });
        }

        let mut upload = GlyphUpload::from_bitmap(glyph, self.config)?;
        if let Some(previous) = self.entries.remove(&key) {
            self.free(previous.allocation);
        }
        while self.entries.len() >= self.config.max_glyphs {
            self.evict_lru();
        }
        let allocation = loop {
            if let Some(allocation) = self.allocate(outer_width, outer_height) {
                break allocation;
            }
            if self.entries.is_empty() {
                return Err(CacheError::GlyphTooLarge {
                    width: glyph.width,
                    height: glyph.height,
                });
            }
            self.evict_lru();
        };
        self.clock = self.clock.saturating_add(1);
        let shelf = &self.shelves[allocation.layer as usize][allocation.shelf];
        let atlas = GlyphAtlasEntry {
            layer: allocation.layer,
            rect: AtlasRect {
                x: allocation.outer_x + self.config.padding,
                y: shelf.y + self.config.padding,
                width: glyph.width,
                height: glyph.height,
            },
            metrics: glyph.metrics,
        };
        self.entries.insert(
            key,
            Entry {
                atlas,
                allocation,
                last_used: self.clock,
            },
        );
        upload.layer = atlas.layer;
        upload.origin = [allocation.outer_x, shelf.y, atlas.layer];
        Ok((atlas, upload))
    }

    fn allocate(&mut self, width: u32, height: u32) -> Option<Allocation> {
        for (layer_index, shelves) in self.shelves.iter_mut().enumerate() {
            for (shelf_index, shelf) in shelves.iter_mut().enumerate() {
                if shelf.height < height {
                    continue;
                }
                if let Some(x) = shelf.take_free_range(width) {
                    return Some(Allocation {
                        layer: layer_index as u32,
                        shelf: shelf_index,
                        outer_x: x,
                        outer_width: width,
                    });
                }
            }
            let y = shelves.last().map_or(0, |shelf| shelf.y + shelf.height);
            if y.checked_add(height)? <= self.config.height {
                let mut shelf = Shelf {
                    y,
                    height,
                    free: std::iter::once(0..self.config.width).collect(),
                };
                let x = shelf.take_free_range(width)?;
                shelves.push(shelf);
                return Some(Allocation {
                    layer: layer_index as u32,
                    shelf: shelves.len() - 1,
                    outer_x: x,
                    outer_width: width,
                });
            }
        }
        None
    }

    fn evict_lru(&mut self) {
        let Some(key) = self
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(key, _)| *key)
        else {
            return;
        };
        if let Some(entry) = self.entries.remove(&key) {
            self.free(entry.allocation);
            self.evictions = self.evictions.saturating_add(1);
        }
    }

    fn free(&mut self, allocation: Allocation) {
        let shelf = &mut self.shelves[allocation.layer as usize][allocation.shelf];
        shelf
            .free
            .push(allocation.outer_x..allocation.outer_x.saturating_add(allocation.outer_width));
        shelf.free.sort_unstable_by_key(|range| range.start);
        let mut merged: Vec<Range<u32>> = Vec::with_capacity(shelf.free.len());
        for range in shelf.free.drain(..) {
            if let Some(previous) = merged.last_mut()
                && range.start <= previous.end
            {
                previous.end = previous.end.max(range.end);
                continue;
            }
            merged.push(range);
        }
        shelf.free = merged;
        if !self
            .entries
            .values()
            .any(|entry| entry.allocation.layer == allocation.layer)
        {
            self.shelves[allocation.layer as usize].clear();
        }
    }
}

impl Shelf {
    fn take_free_range(&mut self, width: u32) -> Option<u32> {
        let index = self
            .free
            .iter()
            .position(|range| range.end.saturating_sub(range.start) >= width)?;
        let x = self.free[index].start;
        self.free[index].start += width;
        if self.free[index].is_empty() {
            self.free.remove(index);
        }
        Some(x)
    }
}

impl AtlasConfig {
    fn align_up(value: u32, alignment: u32) -> Option<u32> {
        value
            .checked_add(alignment.checked_sub(1)?)
            .map(|rounded| rounded & !(alignment - 1))
    }
}

impl GlyphUpload {
    fn from_bitmap(glyph: &GlyphBitmap, config: AtlasConfig) -> Result<Self, CacheError> {
        let width = glyph.width + config.padding * 2;
        let height = glyph.height + config.padding * 2;
        let bytes_per_row = AtlasConfig::align_up(width, config.row_alignment)
            .ok_or(CacheError::GlyphTooLarge { width, height })?;
        let length = usize::try_from(u64::from(bytes_per_row) * u64::from(height))
            .map_err(|_| CacheError::GlyphTooLarge { width, height })?;
        let mut data = Vec::new();
        data.try_reserve_exact(length)
            .map_err(|_| CacheError::GlyphTooLarge { width, height })?;
        data.resize(length, 0);
        for row in 0..glyph.height as usize {
            let source = row * glyph.width as usize;
            let destination =
                (row + config.padding as usize) * bytes_per_row as usize + config.padding as usize;
            data[destination..destination + glyph.width as usize]
                .copy_from_slice(&glyph.coverage[source..source + glyph.width as usize]);
        }
        Ok(Self {
            layer: 0,
            origin: [0; 3],
            extent: [width, height, 1],
            bytes_per_row,
            data,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::GlyphMetrics;

    #[test]
    fn invalid_bitmap_preserves_entries_and_empty_layers_accept_taller_glyphs()
    -> Result<(), CacheError> {
        let mut atlas = GlyphAtlas::new(AtlasConfig {
            width: 4,
            height: 4,
            layers: 1,
            padding: 0,
            row_alignment: 4,
            max_glyphs: 2,
            limits: AtlasLimits::default(),
        })?;
        let (first, _) = atlas.insert(GlyphKey::fixture(1), &GlyphBitmap::fixture(4, 2, 1)?)?;
        atlas.insert(GlyphKey::fixture(2), &GlyphBitmap::fixture(4, 2, 2)?)?;
        let invalid = GlyphBitmap {
            width: 4,
            height: 4,
            coverage: vec![0; 3],
            metrics: GlyphMetrics::default(),
        };
        assert!(matches!(
            atlas.insert(GlyphKey::fixture(1), &invalid),
            Err(CacheError::InvalidBitmapLength { .. })
        ));
        assert_eq!(atlas.get(GlyphKey::fixture(1)), Some(first));
        assert_eq!(atlas.len(), 2);
        assert_eq!(atlas.evictions(), 0);
        let (tall, upload) = atlas.insert(GlyphKey::fixture(3), &GlyphBitmap::fixture(4, 4, 3)?)?;
        assert_eq!(
            tall.rect,
            AtlasRect {
                x: 0,
                y: 0,
                width: 4,
                height: 4
            }
        );
        assert_eq!(upload.data, vec![3; 16]);
        assert_eq!(atlas.len(), 1);
        assert_eq!(atlas.evictions(), 2);
        Ok(())
    }

    impl GlyphBitmap {
        fn fixture(width: u32, height: u32, value: u8) -> Result<GlyphBitmap, CacheError> {
            GlyphBitmap::new(
                width,
                height,
                GlyphMetrics::default(),
                vec![value; (width * height) as usize],
            )
        }
    }

    #[test]
    fn descriptor_and_upload_are_gpu_row_aligned() -> Result<(), CacheError> {
        let mut atlas = GlyphAtlas::new(AtlasConfig {
            limits: AtlasLimits::default(),
            width: 65,
            height: 32,
            layers: 1,
            padding: 1,
            row_alignment: 256,
            max_glyphs: 8,
        })?;
        assert_eq!(atlas.descriptor().aligned_bytes_per_row, 256);

        let (entry, upload) =
            atlas.insert(GlyphKey::fixture(1), &GlyphBitmap::fixture(3, 2, 0x7f)?)?;
        assert_eq!(
            entry.rect,
            AtlasRect {
                x: 1,
                y: 1,
                width: 3,
                height: 2
            }
        );
        assert_eq!(upload.bytes_per_row, 256);
        assert_eq!(upload.data.len(), 1024);
        assert_eq!(upload.origin, [0, 0, 0]);
        assert_eq!(upload.extent, [5, 4, 1]);
        assert!(upload.data[..256].iter().all(|byte| *byte == 0));
        assert_eq!(upload.data[256], 0);
        assert!(upload.data[260..512].iter().all(|byte| *byte == 0));
        assert_eq!(&upload.data[257..260], &[0x7f; 3]);
        assert_eq!(&upload.data[513..516], &[0x7f; 3]);
        assert!(upload.data[516..].iter().all(|byte| *byte == 0));
        Ok(())
    }

    #[test]
    fn lru_eviction_reuses_freed_shelf_space() -> Result<(), CacheError> {
        let mut atlas = GlyphAtlas::new(AtlasConfig {
            limits: AtlasLimits::default(),
            width: 8,
            height: 4,
            layers: 1,
            padding: 0,
            row_alignment: 4,
            max_glyphs: 2,
        })?;
        let (first, _) = atlas.insert(GlyphKey::fixture(1), &GlyphBitmap::fixture(4, 4, 1)?)?;
        let (second, _) = atlas.insert(GlyphKey::fixture(2), &GlyphBitmap::fixture(4, 4, 2)?)?;
        assert_eq!(atlas.get(GlyphKey::fixture(1)), Some(first));

        let (third, _) = atlas.insert(GlyphKey::fixture(3), &GlyphBitmap::fixture(4, 4, 3)?)?;
        assert_eq!(third.rect, second.rect);
        assert!(atlas.get(GlyphKey::fixture(2)).is_none());
        assert!(atlas.get(GlyphKey::fixture(1)).is_some());
        assert_eq!(atlas.evictions(), 1);
        Ok(())
    }

    #[test]
    fn atlas_spills_into_layers_before_evicting() -> Result<(), CacheError> {
        let mut atlas = GlyphAtlas::new(AtlasConfig {
            limits: AtlasLimits::default(),
            width: 4,
            height: 4,
            layers: 2,
            padding: 0,
            row_alignment: 4,
            max_glyphs: 4,
        })?;
        let (_, first_upload) =
            atlas.insert(GlyphKey::fixture(1), &GlyphBitmap::fixture(4, 4, 1)?)?;
        let (_, second_upload) =
            atlas.insert(GlyphKey::fixture(2), &GlyphBitmap::fixture(4, 4, 2)?)?;
        assert_eq!(first_upload.layer, 0);
        assert_eq!(second_upload.layer, 1);
        assert_eq!(atlas.evictions(), 0);
        Ok(())
    }

    #[test]
    fn rejects_invalid_config_and_oversized_glyphs() -> Result<(), CacheError> {
        assert!(matches!(
            GlyphAtlas::new(AtlasConfig {
                layers: AtlasLimits::default().max_atlas_layers + 1,
                ..AtlasConfig::default()
            }),
            Err(CacheError::InvalidAtlasConfig(_))
        ));
        assert!(matches!(
            GlyphAtlas::new(AtlasConfig {
                row_alignment: 3,
                ..AtlasConfig::default()
            }),
            Err(CacheError::InvalidAtlasConfig(_))
        ));
        let mut atlas = GlyphAtlas::new(AtlasConfig {
            limits: AtlasLimits::default(),
            width: 4,
            height: 4,
            layers: 1,
            padding: 1,
            row_alignment: 4,
            max_glyphs: 1,
        })?;
        assert_eq!(
            atlas.insert(GlyphKey::fixture(1), &GlyphBitmap::fixture(4, 4, 1)?),
            Err(CacheError::GlyphTooLarge {
                width: 4,
                height: 4
            })
        );
        Ok(())
    }
}
