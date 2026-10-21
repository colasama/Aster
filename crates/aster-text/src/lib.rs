//! Bounded caches and GPU upload descriptions for text rendering.
//!
//! Authenticated fonts feed bounded shaping and glyph rasterization.
//! Immutable atlas generations preserve upload coordinates while frames retain their leases.

mod atlas;
mod cache;
mod catalog;
mod discovery;
mod face;
mod glyph_generations;
mod project_font_input;
mod project_fonts;
mod raster;
mod raster_bitmap;
mod raster_outline;
mod selection;
mod shaping;
mod text_layout;
mod woff;

#[cfg(test)]
mod catalog_test_font;
#[cfg(test)]
mod catalog_tests;
#[cfg(test)]
mod project_font_tests;
#[cfg(test)]
mod raster_tests;
#[cfg(test)]
mod shaping_tests;

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
pub use glyph_generations::{
    GlyphGeneration, GlyphGenerationConfig, GlyphGenerations, GlyphPage, GlyphPlacement,
};
pub use project_font_input::ProjectFontConfig;
pub use project_fonts::{ProjectFontFallback, ProjectFontResolution, ProjectFontSet};
pub use raster::{
    GlyphHinting, GlyphImage, GlyphImageFormat, GlyphPaint, GlyphRasterConfig, GlyphRasterError,
    GlyphRasterKey, GlyphRasterRequest, GlyphRasterizer,
};
pub use selection::{FontRequest, FontSelection};
pub use shaping::{
    NativeFont, PositionedGlyph, ShapedText, TextDirection, TextShapeConfig, TextShapeError,
    TextShaper,
};
pub use text_layout::{LayoutLine, TextAlignment, TextLayout, TextLayoutRequest, TextLayoutResult};
