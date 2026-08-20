//! Bounded caches and GPU upload descriptions for text rendering.
//!
//! This crate deliberately does not discover fonts, shape text, or rasterize glyphs.
//! Callers provide font bytes and rasterized coverage; this crate manages their lifetime.

mod atlas;
mod cache;

pub use atlas::{
    AtlasConfig, AtlasFormat, AtlasRect, GlyphAtlas, GlyphAtlasDescriptor, GlyphAtlasEntry,
    GlyphUpload,
};
pub use cache::{
    CacheError, CacheStatistics, FontCache, FontId, GlyphBitmap, GlyphCache, GlyphKey, GlyphMetrics,
};
