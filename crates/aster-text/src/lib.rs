//! Bounded caches and GPU upload descriptions for text rendering.
//!
//! This crate discovers font files without shaping text or rasterizing glyphs.
//! Callers provide font bytes and rasterized coverage; this crate manages their lifetime.

mod atlas;
mod cache;
mod discovery;

pub use atlas::{
    AtlasConfig, AtlasFormat, AtlasLimits, AtlasRect, GlyphAtlas, GlyphAtlasDescriptor,
    GlyphAtlasEntry, GlyphUpload,
};
pub use cache::{
    CacheError, CacheStatistics, FontCache, FontId, GlyphBitmap, GlyphCache, GlyphKey, GlyphMetrics,
};
pub use discovery::{FontContainer, FontDiscoveryConfig, FontDiscoveryError, FontFile, LoadedFont};
