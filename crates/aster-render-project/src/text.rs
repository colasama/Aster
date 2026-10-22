use std::sync::Arc;

use aster_render_ir::ResourceHash;
use aster_renderer::{GlyphTextConfig, GlyphTextPlan, NativeGlyphInput};
use aster_text::{
    FontCatalog, FontCatalogConfig, FontDiscoveryConfig, FontSelection, GlyphGeneration,
    GlyphGenerationConfig, GlyphGenerations, GlyphRasterConfig, GlyphRasterizer, TextLayout,
    TextLayoutResult, TextShapeConfig, TextShapeError, TextShaper,
};
use serde::Serialize;

use crate::{
    NativeProjectDocument, ProjectRenderError, ProjectTextPaint, TextFontEvidence,
    text_coverage::{TextCoverage, TextFontCoverage},
    text_fonts::ProjectTextFonts,
    text_preparation::TextPaintPreparation,
    text_style::ProjectTextStyle,
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
    pub fonts: Vec<TextFontEvidence>,
}

pub enum ProjectTextOutcome {
    Native(Box<PreparedProjectText>),
    Retained(Box<TextCapability>),
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
    coverage: TextCoverage,
}

impl NativeProjectText {
    pub(crate) fn inspect_animation_coverage(
        &mut self,
        document: &NativeProjectDocument,
        style: &ProjectTextStyle,
        request: &ProjectTextRequest,
    ) -> Result<Option<String>, ProjectRenderError> {
        if document.runtime_sha256 != self.project_sha256 {
            return Err(ProjectRenderError::Invalid(
                "text project revision differs".into(),
            ));
        }
        let Some(track) = document
            .scene
            .text_animator(&request.composition, &request.layer)?
        else {
            return Ok(None);
        };
        let chain = self.fonts.resolve(style)?;
        self.coverage
            .inspect_animation(style, request, chain, track, (&self.layout, &self.shaper))
    }

    pub(crate) fn inspect_font_coverage(
        &mut self,
        document: &NativeProjectDocument,
        style: &ProjectTextStyle,
        locale: &str,
    ) -> Result<TextFontCoverage, ProjectRenderError> {
        if document.runtime_sha256 != self.project_sha256 {
            return Err(ProjectRenderError::Invalid(
                "text project revision differs".into(),
            ));
        }
        let chain = self.fonts.resolve(style)?;
        self.coverage.inspect(style, locale, chain, &self.shaper)
    }

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
            coverage: TextCoverage::new(Default::default())?,
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
            if let Some(reason) = style.color_coverage_reason() {
                return Err(ProjectRenderError::TextShape(TextShapeError::Unsupported(
                    reason,
                )));
            }
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
            let TextPaintPreparation {
                bounds,
                size,
                scale,
                layout,
                paints,
            } = TextPaintPreparation::evaluate(
                &style,
                &request,
                animation,
                &chain.fonts,
                &self.layout,
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
            )) => Ok(ProjectTextOutcome::Retained(Box::new(TextCapability {
                project_sha256: self.project_sha256.clone(),
                request,
                stage: "layout".into(),
                fonts: chain
                    .selections
                    .iter()
                    .map(TextFontEvidence::from)
                    .collect(),
                reason: format!(
                    "{error}{}",
                    chain
                        .deferred
                        .as_ref()
                        .map_or(String::new(), |r| format!("; {r}"))
                ),
            }))),
            Err(ProjectRenderError::GlyphRaster(aster_text::GlyphRasterError::Unsupported(
                reason,
            ))) => Ok(ProjectTextOutcome::Retained(Box::new(TextCapability {
                project_sha256: self.project_sha256.clone(),
                request,
                stage: "raster".into(),
                fonts: chain
                    .selections
                    .iter()
                    .map(TextFontEvidence::from)
                    .collect(),
                reason: reason.into(),
            }))),
            Err(error) => Err(error),
        }
    }
}
