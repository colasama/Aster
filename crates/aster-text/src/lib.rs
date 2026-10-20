//! Bounded caches and GPU upload descriptions for text rendering.
//!
//! Font discovery and bounded face selection precede shaping and rasterization.
//! Callers provide glyph coverage; this crate manages font, glyph and atlas lifetimes.

mod atlas;
mod cache;
mod catalog;
mod discovery;
mod face;
mod project_font_input;
mod project_fonts;
mod selection;
mod woff;

#[cfg(test)]
mod catalog_test_font;
#[cfg(test)]
mod catalog_tests;
#[cfg(test)]
mod project_font_tests;

pub use atlas::{
    AtlasConfig, AtlasFormat, AtlasLimits, AtlasRect, GlyphAtlas, GlyphAtlasDescriptor,
    GlyphAtlasEntry, GlyphUpload,
};
pub use cache::{
    CacheError, CacheStatistics, FontCache, FontId, GlyphBitmap, GlyphCache, GlyphKey, GlyphMetrics,
};
pub use catalog::{FontCatalog, FontCatalogConfig, FontCatalogError};
pub use discovery::{FontContainer, FontDiscoveryConfig, FontDiscoveryError, FontFile, LoadedFont};
pub use face::{FontAxis, FontFaceId, FontFaceMetadata, FontStyle};
pub use project_font_input::ProjectFontConfig;
pub use project_fonts::{ProjectFontFallback, ProjectFontResolution, ProjectFontSet};
pub use selection::{FontRequest, FontSelection};
