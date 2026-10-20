use crate::{NativeProjectDocument, ProjectRenderError};
use aster_eval::FramePlanRequest;
use aster_render_ir::{
    AntiAliasing, DecodeLimits, ExportVideoConfig, Extent2d, FrameRate, RationalFrameRate,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectExportSettings {
    pub composition: String,
    pub start_time: f64,
    pub start_frame: Option<u64>,
    pub frame_count: Option<u64>,
    pub size: Option<Extent2d>,
    pub frame_rate: Option<RationalFrameRate>,
    pub bitrate_bps: u32,
    pub anti_aliasing: AntiAliasing,
}

pub struct ProjectExportSchedule {
    pub frames: Vec<FramePlanRequest>,
    pub video: ExportVideoConfig,
    pub start_time: f64,
    pub composition_duration: f64,
}

impl NativeProjectDocument {
    pub fn export_schedule(
        &self,
        settings: ProjectExportSettings,
    ) -> Result<ProjectExportSchedule, ProjectRenderError> {
        let composition = self.scene.composition(&settings.composition)?;
        let duration = composition
            .duration
            .as_f64()
            .ok_or_else(|| ProjectRenderError::Invalid("composition duration absent".into()))?;
        let size = match settings.size {
            Some(size) => size,
            None => {
                let width = composition.width.as_f64().ok_or_else(|| {
                    ProjectRenderError::Invalid("composition width absent".into())
                })?;
                let height = composition.height.as_f64().ok_or_else(|| {
                    ProjectRenderError::Invalid("composition height absent".into())
                })?;
                if width.fract() != 0.
                    || height.fract() != 0.
                    || !(1.0..=16384.0).contains(&width)
                    || !(1.0..=16384.0).contains(&height)
                {
                    return Err(ProjectRenderError::Invalid(
                        "export dimensions are not bounded integers".into(),
                    ));
                }
                Extent2d {
                    width: width as u32,
                    height: height as u32,
                }
            }
        };
        let rate = match settings.frame_rate {
            Some(rate) => rate,
            None => {
                let numerator =
                    composition.frame_rate.numerator.as_f64().ok_or_else(|| {
                        ProjectRenderError::Invalid("frame numerator absent".into())
                    })?;
                let denominator = composition.frame_rate.denominator.as_f64().ok_or_else(|| {
                    ProjectRenderError::Invalid("frame denominator absent".into())
                })?;
                let FrameRate::Rational {
                    numerator,
                    denominator,
                } = FramePlanRequest::frame_rate(numerator, denominator)?
                else {
                    return Err(ProjectRenderError::Invalid(
                        "export requires an explicit bounded rational frame rate".into(),
                    ));
                };
                RationalFrameRate {
                    numerator,
                    denominator,
                }
            }
        };
        let video = ExportVideoConfig {
            size,
            frame_rate: rate,
            bitrate_bps: settings.bitrate_bps,
        };
        let limits = DecodeLimits::default();
        video.validate(&limits)?;
        if settings.start_frame.is_some_and(|frame| {
            frame > 9_007_199_254_740_991 - self.limits.render_project_frames as u64
                || settings.start_time != 0.
        }) {
            return Err(ProjectRenderError::Invalid(
                "absolute start frame must be bounded and cannot accompany a time offset".into(),
            ));
        }
        let start_time = settings.start_frame.map_or(settings.start_time, |frame| {
            frame as f64 * f64::from(rate.denominator) / f64::from(rate.numerator)
        });
        if !start_time.is_finite() || start_time < 0. || start_time >= duration {
            return Err(ProjectRenderError::Invalid(
                "export start is outside composition".into(),
            ));
        }
        let fps = f64::from(rate.numerator) / f64::from(rate.denominator);
        let maximum = settings.start_frame.map_or_else(
            || ((duration - start_time) * fps).ceil(),
            |first| (duration * fps).ceil() - first as f64,
        );
        let count = settings.frame_count.map(|n| n as f64).unwrap_or(maximum);
        if count < 1. || count > maximum || count > self.limits.render_project_frames as f64 {
            return Err(ProjectRenderError::Invalid(
                "export frame count exceeds composition or job budget".into(),
            ));
        }
        let scale = match settings.anti_aliasing {
            AntiAliasing::Ssaa2x => 2,
            AntiAliasing::Ssaa4x => 4,
            _ => 1,
        };
        let render_target = Extent2d {
            width: size
                .width
                .checked_mul(scale)
                .ok_or_else(|| ProjectRenderError::Invalid("export width overflow".into()))?,
            height: size
                .height
                .checked_mul(scale)
                .ok_or_else(|| ProjectRenderError::Invalid("export height overflow".into()))?,
        };
        render_target.validate(&limits)?;
        let frames = (0..count as u64)
            .map(|index| FramePlanRequest {
                snapshot_scope: format!("native-project:{}", self.authored_sha256),
                project_revision: 0,
                composition_id: settings.composition.clone(),
                time: settings.start_frame.map_or_else(
                    || {
                        start_time
                            + index as f64 * f64::from(rate.denominator) / f64::from(rate.numerator)
                    },
                    |first| {
                        (first + index) as f64 * f64::from(rate.denominator)
                            / f64::from(rate.numerator)
                    },
                ),
                target: size,
                render_target,
                anti_aliasing: settings.anti_aliasing,
                shadows_enabled: true,
            })
            .collect();
        Ok(ProjectExportSchedule {
            frames,
            video,
            start_time,
            composition_duration: duration,
        })
    }
}
