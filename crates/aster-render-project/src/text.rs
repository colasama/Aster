use std::sync::Arc;

use aster_render_ir::{Extent2d, ResourceHash};
use aster_renderer::{GlyphTextConfig, GlyphTextPlan, NativeGlyphInput};
use aster_text::{
    FontCatalog, FontCatalogConfig, FontDiscoveryConfig, FontSelection, GlyphGeneration,
    GlyphGenerationConfig, GlyphGenerations, GlyphRasterConfig, GlyphRasterizer, TextLayout,
    TextLayoutResult, TextShapeConfig, TextShapeError, TextShaper,
};
use serde::Serialize;

use crate::{
    NativeProjectDocument, ProjectRenderError, ProjectTextPaint, text_fonts::ProjectTextFonts,
    text_paint::TextPaintEvaluator, text_style::ProjectTextStyle,
};

#[derive(Clone, Debug, serde::Deserialize, Serialize)]
pub struct ProjectTextRequest {
    pub composition: String,
    pub layer: String,
    pub source_time: f64,
    pub resolution_scale: f64,
    pub maximum_dimension: u32,
    pub locale: String,
    /// A shared temporal-sample union, when supplied by the native exposure planner.
    pub bounds: Option<[f64; 4]>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TextCapability {
    pub project_sha256: String,
    pub request: ProjectTextRequest,
    pub stage: String,
    pub reason: String,
}

pub enum ProjectTextOutcome {
    Native(Box<PreparedProjectText>),
    Retained(TextCapability),
}

/// Owns the immutable atlas lease; no full-layer CPU raster is produced.
pub struct PreparedProjectText {
    pub project_sha256: String,
    pub request: ProjectTextRequest,
    pub fonts: Vec<FontSelection>,
    pub bounds: [f64; 4],
    pub layout: TextLayoutResult,
    pub paints: Vec<ProjectTextPaint>,
    pub atlas: Arc<GlyphGeneration>,
    pub plan: GlyphTextPlan,
}

impl PreparedProjectText {
    pub fn into_input(
        self,
        frame: ResourceHash,
        budget: u64,
    ) -> Result<NativeGlyphInput, ProjectRenderError> {
        Ok(NativeGlyphInput::new(
            frame,
            self.atlas,
            self.plan,
            GlyphTextConfig::default(),
            budget,
        )?)
    }
}

pub struct NativeProjectText {
    project_sha256: String,
    fonts: ProjectTextFonts,
    layout: TextLayout,
    shaper: TextShaper,
    raster: GlyphRasterizer,
    generations: GlyphGenerations,
}

impl NativeProjectText {
    pub fn new(
        document: &NativeProjectDocument,
        platform: FontCatalog,
    ) -> Result<Self, ProjectRenderError> {
        Ok(Self {
            project_sha256: document.runtime_sha256.clone(),
            fonts: ProjectTextFonts::new(document, platform)?,
            layout: TextLayout::new(TextShapeConfig::default())?,
            shaper: TextShaper::new(TextShapeConfig::default())?,
            raster: GlyphRasterizer::new(GlyphRasterConfig::default())?,
            generations: GlyphGenerations::new(GlyphGenerationConfig::default())?,
        })
    }

    pub fn discover_platform(
        document: &NativeProjectDocument,
        discovery: &FontDiscoveryConfig,
        config: FontCatalogConfig,
    ) -> Result<FontCatalog, ProjectRenderError> {
        ProjectTextFonts::discover(document, discovery, config)
    }

    pub fn prepare(
        &mut self,
        document: &NativeProjectDocument,
        request: ProjectTextRequest,
    ) -> Result<ProjectTextOutcome, ProjectRenderError> {
        if document.runtime_sha256 != self.project_sha256
            || !request.source_time.is_finite()
            || !request.resolution_scale.is_finite()
            || !(1.0..=8.0).contains(&request.resolution_scale)
            || request.maximum_dimension == 0
            || request.maximum_dimension > 16384
            || request.locale.is_empty()
            || request.locale.len() > 64
            || !request.locale.is_ascii()
        {
            return Err(ProjectRenderError::Invalid(
                "text project revision or request bounds".into(),
            ));
        }
        let style = ProjectTextStyle::from_layer(
            document.scene.layer(&request.composition, &request.layer)?,
        )?;
        let chain = self.fonts.resolve(&style)?;
        let result = (|| {
            if chain.fonts.is_empty() {
                return Err(ProjectRenderError::TextShape(TextShapeError::Unsupported(
                    "requested fonts unavailable",
                )));
            }
            let animation = document
                .scene
                .text_animator(&request.composition, &request.layer)?
                .map(|track| track.evaluate(request.source_time))
                .transpose()?;
            let animation = animation.as_ref().filter(|_| style.animated);
            let measured = self
                .layout
                .evaluate(&style.layout(&request.locale, 1.), &chain.fonts)?;
            let paints = TextPaintEvaluator::evaluate(
                &style,
                &measured,
                animation,
                1.,
                &request.locale,
                &chain.fonts,
                &self.shaper,
            )?;
            let measured_bounds = crate::text_raster::TextRasterPreparation::bounds(
                style.size,
                style.font_size,
                &paints,
                &chain.fonts,
            )?;
            let bounds = request.bounds.unwrap_or(measured_bounds);
            if bounds
                .iter()
                .any(|n| !n.is_finite() || n.abs() > 1_048_576.)
                || bounds[2] < 1.
                || bounds[3] < 1.
                || bounds[0] > measured_bounds[0]
                || bounds[1] > measured_bounds[1]
                || bounds[0] + bounds[2] < measured_bounds[0] + measured_bounds[2]
                || bounds[1] + bounds[3] < measured_bounds[1] + measured_bounds[3]
            {
                return Err(ProjectRenderError::Invalid(
                    "text union bounds do not contain measured ink".into(),
                ));
            }
            let scale = request
                .resolution_scale
                .min(request.maximum_dimension as f64 / bounds[2].max(bounds[3]));
            let size = Extent2d {
                width: (bounds[2] * scale).ceil().max(1.) as u32,
                height: (bounds[3] * scale).ceil().max(1.) as u32,
            };
            let scale = size.width as f64 / bounds[2];
            let layout = self
                .layout
                .evaluate(&style.layout(&request.locale, scale), &chain.fonts)?;
            let paints = TextPaintEvaluator::evaluate(
                &style,
                &layout,
                animation,
                scale,
                &request.locale,
                &chain.fonts,
                &self.shaper,
            )?;
            let (atlas, plan) = crate::text_raster::TextRasterPreparation::rasterize(
                &paints,
                &chain.fonts,
                style.font_size * scale,
                (bounds, size),
                &mut self.raster,
                &mut self.generations,
            )?;
            Ok(PreparedProjectText {
                project_sha256: self.project_sha256.clone(),
                request: request.clone(),
                fonts: chain.selections.clone(),
                bounds,
                layout,
                paints,
                atlas,
                plan,
            })
        })();
        match result {
            Ok(prepared) => Ok(ProjectTextOutcome::Native(Box::new(prepared))),
            Err(ProjectRenderError::TextShape(
                error @ (TextShapeError::Unsupported(_) | TextShapeError::MissingGlyph { .. }),
            )) => Ok(ProjectTextOutcome::Retained(TextCapability {
                project_sha256: self.project_sha256.clone(),
                request,
                stage: "layout".into(),
                reason: format!(
                    "{error}{}",
                    chain
                        .deferred
                        .as_ref()
                        .map_or(String::new(), |r| format!("; {r}"))
                ),
            })),
            Err(ProjectRenderError::GlyphRaster(aster_text::GlyphRasterError::Unsupported(
                reason,
            ))) => Ok(ProjectTextOutcome::Retained(TextCapability {
                project_sha256: self.project_sha256.clone(),
                request,
                stage: "raster".into(),
                reason: reason.into(),
            })),
            Err(error) => Err(error),
        }
    }
}
