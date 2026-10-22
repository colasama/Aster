use aster_eval::TextAnimatorFrame;
use aster_render_ir::Extent2d;
use aster_text::{NativeFont, TextLayout, TextLayoutResult, TextShaper};

use crate::{
    ProjectRenderError, ProjectTextPaint, ProjectTextRequest, text_paint::TextPaintEvaluator,
    text_raster::TextRasterPreparation, text_style::ProjectTextStyle,
};

/// Shared layout and paint evaluation before allocating any glyph atlas.
pub(crate) struct TextPaintPreparation {
    pub bounds: [f64; 4],
    pub size: Extent2d,
    pub scale: f64,
    pub layout: TextLayoutResult,
    pub paints: Vec<ProjectTextPaint>,
}

impl TextPaintPreparation {
    pub fn evaluate(
        style: &ProjectTextStyle,
        request: &ProjectTextRequest,
        animation: Option<&TextAnimatorFrame>,
        fonts: &[NativeFont],
        layout: &TextLayout,
        shaper: &TextShaper,
    ) -> Result<Self, ProjectRenderError> {
        let measured = layout.evaluate(&style.layout(&request.locale, 1.), fonts)?;
        let paints = TextPaintEvaluator::evaluate(
            style,
            &measured,
            animation,
            1.,
            &request.locale,
            fonts,
            shaper,
        )?;
        let measured_bounds =
            TextRasterPreparation::bounds(style.size, style.font_size, &paints, fonts)?;
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
        let layout = layout.evaluate(&style.layout(&request.locale, scale), fonts)?;
        let paints = TextPaintEvaluator::evaluate(
            style,
            &layout,
            animation,
            scale,
            &request.locale,
            fonts,
            shaper,
        )?;
        Ok(Self {
            bounds,
            size,
            scale,
            layout,
            paints,
        })
    }
}
