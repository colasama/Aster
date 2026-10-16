use aster_render_ir::ExportVideoConfig;
use windows::{
    Win32::{Media::MediaFoundation::*, System::Variant::VARIANT},
    core::{GUID, Interface},
};

use crate::EncoderProbeLimits;

pub(crate) struct MfQuality {
    values: Vec<(GUID, u32)>,
}

impl MfQuality {
    pub(crate) fn new(video: &ExportVideoConfig, limits: &EncoderProbeLimits) -> Self {
        let mut values = vec![
            (
                CODECAPI_AVEncCommonRateControlMode,
                limits.encoder_rate_control,
            ),
            (CODECAPI_AVEncCommonMeanBitRate, video.bitrate_bps),
        ];
        if limits.encoder_rate_control == eAVEncCommonRateControlMode_PeakConstrainedVBR.0 as u32 {
            values.push((CODECAPI_AVEncCommonMaxBitRate, video.bitrate_bps));
        }
        if let Some(quality) = limits.encoder_quality_vs_speed {
            values.push((CODECAPI_AVEncCommonQualityVsSpeed, quality));
        }
        if let Some(max_qp) = limits.encoder_max_qp {
            // Use the rational frame rate without rounding. A large bitrate budget should
            // improve the first intra frame as well as later rate-controller predictions.
            let budget = u128::from(video.bitrate_bps) * u128::from(video.frame_rate.denominator);
            let threshold = u128::from(video.size.width)
                * u128::from(video.size.height)
                * u128::from(video.frame_rate.numerator)
                * u128::from(limits.encoder_high_budget_bits_per_pixel);
            let max_qp = if budget >= threshold {
                max_qp.min(limits.encoder_high_budget_max_qp)
            } else {
                max_qp
            };
            values.push((CODECAPI_AVEncVideoMaxQP, max_qp));
        }
        if let Some(frames) = limits.encoder_gop_frames {
            values.push((CODECAPI_AVEncMPVGOPSize, frames));
        }
        Self { values }
    }

    pub(crate) fn apply(&self, transform: &IMFTransform) -> windows::core::Result<()> {
        // Configure before media types, as required by the Media Foundation codec contract.
        // https://learn.microsoft.com/windows/win32/medfound/h-264-video-encoder
        unsafe {
            let codec: ICodecAPI = transform.cast()?;
            for (key, expected) in &self.values {
                codec.SetValue(key, &VARIANT::from(*expected))?;
            }
        }
        self.verify(transform)
    }

    /// Media-type negotiation must not silently replace requested rate or quality settings.
    pub(crate) fn verify(&self, transform: &IMFTransform) -> windows::core::Result<()> {
        unsafe {
            let codec: ICodecAPI = transform.cast()?;
            for (key, expected) in &self.values {
                let actual = u32::try_from(&codec.GetValue(key)?)?;
                if actual != *expected {
                    return Err(windows::core::Error::new(
                        windows::Win32::Foundation::E_INVALIDARG,
                        "hardware encoder did not retain requested quality policy",
                    ));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aster_render_ir::{Extent2d, RationalFrameRate};
    use clap::Parser;

    #[derive(Parser)]
    struct Options {
        #[command(flatten)]
        limits: EncoderProbeLimits,
    }

    #[test]
    fn spatial_budget_tightens_only_high_budget_quantization() -> Result<(), clap::Error> {
        let mut limits = Options::try_parse_from(["test"])?.limits;
        let mut video = ExportVideoConfig {
            size: Extent2d {
                width: 320,
                height: 180,
            },
            frame_rate: RationalFrameRate {
                numerator: 30_000,
                denominator: 1001,
            },
            bitrate_bps: 20_000_000,
        };
        for (bitrate, expected) in [(20_000_000, 12), (1_726_274, 12), (1_726_273, 18)] {
            video.bitrate_bps = bitrate;
            let policy = MfQuality::new(&video, &limits);
            assert!(
                policy
                    .values
                    .contains(&(CODECAPI_AVEncVideoMaxQP, expected))
            );
            assert!(
                policy
                    .values
                    .contains(&(CODECAPI_AVEncCommonMeanBitRate, bitrate))
            );
            assert!(
                policy
                    .values
                    .contains(&(CODECAPI_AVEncCommonMaxBitRate, bitrate))
            );
        }
        video.bitrate_bps = 20_000_000;
        video.size = Extent2d {
            width: 1920,
            height: 1080,
        };
        assert!(
            MfQuality::new(&video, &limits)
                .values
                .contains(&(CODECAPI_AVEncVideoMaxQP, 18))
        );
        video.size = Extent2d {
            width: 320,
            height: 180,
        };
        limits.encoder_max_qp = Some(4);
        assert!(
            MfQuality::new(&video, &limits)
                .values
                .contains(&(CODECAPI_AVEncVideoMaxQP, 4))
        );
        limits.encoder_max_qp = None;
        assert!(
            !MfQuality::new(&video, &limits)
                .values
                .iter()
                .any(|(key, _)| *key == CODECAPI_AVEncVideoMaxQP)
        );
        Ok(())
    }
}
