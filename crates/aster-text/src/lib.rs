//! Bounded caches and GPU upload descriptions for text rendering.
//!
//! This crate deliberately does not discover fonts, shape text, or rasterize glyphs.
//! Callers provide font bytes and rasterized coverage; this crate manages their lifetime.

mod atlas;
mod cache;
mod discovery;

pub use atlas::{
    AtlasConfig, AtlasFormat, AtlasRect, GlyphAtlas, GlyphAtlasDescriptor, GlyphAtlasEntry,
    GlyphUpload,
};
pub use cache::{
    CacheError, CacheStatistics, FontCache, FontId, GlyphBitmap, GlyphCache, GlyphKey, GlyphMetrics,
};
pub use discovery::{
    FontContainer, FontDiscoveryError, FontFile, LoadedFont, discover_font_files, load_font_file,
    platform_font_roots,
};
