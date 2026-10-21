//! Job-local native project evaluation and authenticated resource acquisition.
mod audio;
mod audio_resample;
mod document;
mod export;
mod export_audio;
mod export_control;
mod export_schedule;
pub use audio::{NativeProjectAudio, ProjectAudioLimits, ProjectAudioReceipt};
pub use export::{
    NativeProjectExport, ProjectExportObserver, ProjectExportProgress, ProjectExportReport,
};
pub use export_control::ProjectExportControl;
pub use export_schedule::{ProjectExportSchedule, ProjectExportSettings};
mod file_media;
mod generators;
mod gpu;
mod installed_generators;
mod materials;
mod raster_frame;
mod raster_manifest;
mod raster_provider;
mod raster_transport;
pub use raster_provider::{NativeRasterProvider, RasterProviderOptions, RasterProviderReady};
mod session;
mod text;
mod text_fonts;
mod text_paint;
mod text_raster;
mod text_style;
mod text_units;
pub use document::{NativeProjectDocument, ProjectRenderLimits};
pub use file_media::{NativeProjectFileMedia, ProjectFileMediaFrame};
pub use generators::NativeProjectGenerators;
pub use gpu::NativeProjectGpu;
pub use materials::{DecodedMaterialPixels, NativeProjectMaterials, ProjectMaterialFrame};
pub use raster_frame::ProjectRasterFrame;
pub use session::{NativeProjectSession, PreparedProjectFrame, ProjectFrameSettings};
pub use text::{
    NativeProjectText, PreparedProjectText, ProjectTextOutcome, ProjectTextRequest, TextCapability,
};
pub use text_paint::{ProjectTextPaint, TextAffine};

#[derive(Debug, thiserror::Error)]
pub enum ProjectRenderError {
    #[error(transparent)]
    Font(#[from] aster_text::FontCatalogError),
    #[error(transparent)]
    FontDiscovery(#[from] aster_text::FontDiscoveryError),
    #[error(transparent)]
    TextShape(#[from] aster_text::TextShapeError),
    #[error(transparent)]
    GlyphRaster(#[from] aster_text::GlyphRasterError),
    #[error(transparent)]
    Encode(#[from] aster_encode::EncodeError),
    #[error(transparent)]
    Export(#[from] aster_video::ExportError),
    #[error(transparent)]
    Render(#[from] aster_renderer::RenderError),
    #[error(transparent)]
    Audio(#[from] aster_video::FfmpegError),
    #[error(transparent)]
    Project(#[from] aster_project::ProjectError),
    #[error(transparent)]
    Evaluation(#[from] aster_eval::EvaluationError),
    #[error(transparent)]
    Media(#[from] aster_media_native::MediaError),
    #[error(transparent)]
    Ir(#[from] aster_render_ir::IrError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("invalid native project render input: {0}")]
    Invalid(String),
}
