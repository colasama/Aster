use std::{collections::HashMap, sync::Arc};

use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct FontId(pub u64);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct GlyphKey {
    pub font: FontId,
    pub glyph_id: u32,
    /// Pixel size in 1/64 pixel units.
    pub size_q64: u32,
    /// Quantized horizontal subpixel offset in 1/64 pixel units.
    pub subpixel_x_q64: i8,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GlyphMetrics {
    pub bearing_x: f32,
    pub bearing_y: f32,
    pub advance_x: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GlyphBitmap {
    pub width: u32,
    pub height: u32,
    pub metrics: GlyphMetrics,
    /// Tightly packed, one-byte coverage values.
    pub coverage: Vec<u8>,
}

impl GlyphBitmap {
    pub fn new(
        width: u32,
        height: u32,
        metrics: GlyphMetrics,
        coverage: Vec<u8>,
    ) -> Result<Self, CacheError> {
        if width == 0 || height == 0 {
            return Err(CacheError::EmptyGlyph);
        }
        let expected = u64::from(width) * u64::from(height);
        if expected != coverage.len() as u64 {
            return Err(CacheError::InvalidBitmapLength {
                expected,
                actual: coverage.len() as u64,
            });
        }
        Ok(Self {
            width,
            height,
            metrics,
            coverage,
        })
    }

    #[must_use]
    pub fn byte_len(&self) -> u64 {
        self.coverage.len() as u64
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CacheStatistics {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub entries: usize,
    pub bytes: u64,
    pub byte_budget: u64,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum CacheError {
    #[error("item requires {required} bytes, exceeding the {budget}-byte cache budget")]
    ItemExceedsBudget { required: u64, budget: u64 },
    #[error("glyph bitmap needs {expected} coverage bytes, but received {actual}")]
    InvalidBitmapLength { expected: u64, actual: u64 },
    #[error("glyph dimensions cannot be zero")]
    EmptyGlyph,
    #[error("font data cannot be empty")]
    EmptyFont,
    #[error("glyph {width}x{height} does not fit the atlas")]
    GlyphTooLarge { width: u32, height: u32 },
    #[error("atlas configuration is invalid: {0}")]
    InvalidAtlasConfig(&'static str),
}

struct Entry<T> {
    value: T,
    bytes: u64,
    last_used: u64,
}

struct BoundedCache<K, V> {
    entries: HashMap<K, Entry<V>>,
    byte_budget: u64,
    bytes: u64,
    clock: u64,
    hits: u64,
    misses: u64,
    evictions: u64,
}

impl<K: Copy + Eq + std::hash::Hash, V> BoundedCache<K, V> {
    fn new(byte_budget: u64) -> Self {
        Self {
            entries: HashMap::new(),
            byte_budget,
            bytes: 0,
            clock: 0,
            hits: 0,
            misses: 0,
            evictions: 0,
        }
    }

    fn next_tick(&mut self) -> u64 {
        self.clock = self.clock.wrapping_add(1);
        self.clock
    }

    fn get(&mut self, key: K) -> Option<&V> {
        let tick = self.next_tick();
        if let Some(entry) = self.entries.get_mut(&key) {
            self.hits += 1;
            entry.last_used = tick;
            Some(&entry.value)
        } else {
            self.misses += 1;
            None
        }
    }

    fn insert(&mut self, key: K, value: V, bytes: u64) -> Result<(), CacheError> {
        if bytes > self.byte_budget {
            return Err(CacheError::ItemExceedsBudget {
                required: bytes,
                budget: self.byte_budget,
            });
        }
        if let Some(previous) = self.entries.remove(&key) {
            self.bytes -= previous.bytes;
        }
        while self.bytes.saturating_add(bytes) > self.byte_budget {
            self.evict_lru();
        }
        let last_used = self.next_tick();
        self.entries.insert(
            key,
            Entry {
                value,
                bytes,
                last_used,
            },
        );
        self.bytes += bytes;
        Ok(())
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
            self.bytes -= entry.bytes;
            self.evictions += 1;
        }
    }

    fn statistics(&self) -> CacheStatistics {
        CacheStatistics {
            hits: self.hits,
            misses: self.misses,
            evictions: self.evictions,
            entries: self.entries.len(),
            bytes: self.bytes,
            byte_budget: self.byte_budget,
        }
    }
}

pub struct FontCache {
    cache: BoundedCache<FontId, Arc<[u8]>>,
}

impl FontCache {
    #[must_use]
    pub fn new(byte_budget: u64) -> Self {
        Self {
            cache: BoundedCache::new(byte_budget),
        }
    }

    pub fn insert(&mut self, id: FontId, data: impl Into<Arc<[u8]>>) -> Result<(), CacheError> {
        let data = data.into();
        if data.is_empty() {
            return Err(CacheError::EmptyFont);
        }
        self.cache.insert(id, data.clone(), data.len() as u64)
    }

    pub fn get(&mut self, id: FontId) -> Option<Arc<[u8]>> {
        self.cache.get(id).cloned()
    }

    #[must_use]
    pub fn statistics(&self) -> CacheStatistics {
        self.cache.statistics()
    }
}

pub struct GlyphCache {
    cache: BoundedCache<GlyphKey, Arc<GlyphBitmap>>,
}

impl GlyphCache {
    #[must_use]
    pub fn new(byte_budget: u64) -> Self {
        Self {
            cache: BoundedCache::new(byte_budget),
        }
    }

    pub fn insert(&mut self, key: GlyphKey, glyph: GlyphBitmap) -> Result<(), CacheError> {
        let bytes = glyph.byte_len();
        self.cache.insert(key, Arc::new(glyph), bytes)
    }

    pub fn get(&mut self, key: GlyphKey) -> Option<Arc<GlyphBitmap>> {
        self.cache.get(key).cloned()
    }

    #[must_use]
    pub fn statistics(&self) -> CacheStatistics {
        self.cache.statistics()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(id: u32) -> GlyphKey {
        GlyphKey {
            font: FontId(1),
            glyph_id: id,
            size_q64: 16 * 64,
            subpixel_x_q64: 0,
        }
    }

    #[test]
    fn font_cache_evicts_the_least_recently_used_blob() {
        let mut cache = FontCache::new(6);
        cache
            .insert(FontId(1), Arc::<[u8]>::from([1, 2, 3]))
            .unwrap();
        cache
            .insert(FontId(2), Arc::<[u8]>::from([4, 5, 6]))
            .unwrap();
        assert!(cache.get(FontId(1)).is_some());
        cache
            .insert(FontId(3), Arc::<[u8]>::from([7, 8, 9]))
            .unwrap();

        assert!(cache.get(FontId(1)).is_some());
        assert!(cache.get(FontId(2)).is_none());
        assert!(cache.get(FontId(3)).is_some());
        assert_eq!(cache.statistics().evictions, 1);
    }

    #[test]
    fn glyph_cache_validates_and_bounds_coverage_memory() {
        let mut fonts = FontCache::new(4);
        assert_eq!(
            fonts.insert(FontId(1), Arc::<[u8]>::from([])),
            Err(CacheError::EmptyFont)
        );
        assert_eq!(
            GlyphBitmap::new(0, 0, GlyphMetrics::default(), Vec::new()),
            Err(CacheError::EmptyGlyph)
        );
        assert_eq!(
            GlyphBitmap::new(2, 2, GlyphMetrics::default(), vec![0; 3]),
            Err(CacheError::InvalidBitmapLength {
                expected: 4,
                actual: 3,
            })
        );
        let mut cache = GlyphCache::new(4);
        cache
            .insert(
                key(1),
                GlyphBitmap::new(2, 2, GlyphMetrics::default(), vec![255; 4]).unwrap(),
            )
            .unwrap();
        cache
            .insert(
                key(2),
                GlyphBitmap::new(2, 2, GlyphMetrics::default(), vec![128; 4]).unwrap(),
            )
            .unwrap();
        assert!(cache.get(key(1)).is_none());
        assert!(cache.get(key(2)).is_some());
        assert_eq!(cache.statistics().bytes, 4);
    }
}
