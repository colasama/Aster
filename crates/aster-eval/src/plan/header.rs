use crate::EvaluationError;
use aster_render_ir::{
    AntiAliasing, BinaryRationalTime, ColorPipeline, CompositionIdentity, Extent2d,
    FrameHeaderSlice, FrameRate, FrameTime,
};
use aster_types::editor::Composition;
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FramePlanRequest {
    pub snapshot_scope: String,
    pub project_revision: u64,
    pub composition_id: String,
    pub time: f64,
    pub target: Extent2d,
    pub render_target: Extent2d,
    pub anti_aliasing: AntiAliasing,
    pub shadows_enabled: bool,
}

impl FramePlanRequest {
    pub fn header(&self, composition: &Composition) -> Result<FrameHeaderSlice, EvaluationError> {
        if self.composition_id != composition.id {
            return Err(EvaluationError::InvalidScene(
                "frame composition mismatch".into(),
            ));
        }
        let numerator =
            composition.frame_rate.numerator.as_f64().ok_or_else(|| {
                EvaluationError::InvalidScene("invalid frame rate numerator".into())
            })?;
        let denominator = composition.frame_rate.denominator.as_f64().ok_or_else(|| {
            EvaluationError::InvalidScene("invalid frame rate denominator".into())
        })?;
        let time = FrameTime::from_f64(self.time)
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        Ok(FrameHeaderSlice {
            snapshot_scope: self.snapshot_scope.clone(),
            project_revision: self.project_revision,
            composition_id: CompositionIdentity::Unicode(composition.id.clone()),
            time,
            frame_rate: Self::frame_rate(numerator, denominator)?,
            target: self.target,
            render_target: self.render_target,
            aa: self.anti_aliasing,
            color_pipeline: ColorPipeline::LinearHdrToSrgbDisplay,
        })
    }

    pub fn frame_rate(numerator: f64, denominator: f64) -> Result<FrameRate, EvaluationError> {
        let numerator = BinaryRationalTime::from_positive_f64(numerator)
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        let denominator = BinaryRationalTime::from_positive_f64(denominator)
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        let BinaryRationalTime::BinaryRational {
            significand: mut top,
            exponent: top_exponent,
            ..
        } = numerator;
        let BinaryRationalTime::BinaryRational {
            significand: mut bottom,
            exponent: bottom_exponent,
            ..
        } = denominator;
        let (mut a, mut b) = (top, bottom);
        while b != 0 {
            (a, b) = (b, a % b);
        }
        top /= a;
        bottom /= a;
        let exponent = i32::from(top_exponent) - i32::from(bottom_exponent);
        let bounded = if (0..32).contains(&exponent) && top <= (u64::from(u32::MAX) >> exponent) {
            Some((top << exponent, bottom))
        } else if (-31..0).contains(&exponent) && bottom <= (u64::from(u32::MAX) >> -exponent) {
            Some((top, bottom << -exponent))
        } else {
            None
        };
        if let Some((top, bottom)) = bounded
            && top <= u64::from(u32::MAX)
            && bottom <= u64::from(u32::MAX)
        {
            return Ok(FrameRate::Rational {
                numerator: top as u32,
                denominator: bottom as u32,
            });
        }
        Ok(FrameRate::BinaryRatio {
            numerator,
            denominator,
        })
    }
}
