use std::cmp::Ordering;

use aster_render_ir::FrameTime;
use aster_video::{PresentationFrame, Timebase};

use crate::MediaError;

pub(crate) struct VideoTime(FrameTime);

impl VideoTime {
    pub(crate) fn new(time: FrameTime) -> Result<Self, MediaError> {
        time.validate()?;
        let negative = match time {
            FrameTime::Rational { value, .. } => value < 0,
            FrameTime::BinaryRational {
                negative,
                significand,
                ..
            } => negative && significand != 0,
        };
        if negative {
            return Err(MediaError::Unsupported(
                "negative video request time".into(),
            ));
        }
        Ok(Self(time))
    }

    fn compare(&self, ticks: u64, base: Timebase) -> Ordering {
        let right = u128::from(ticks) * u128::from(base.numerator);
        match self.0 {
            FrameTime::Rational { value, scale } => {
                (value as u128 * u128::from(base.denominator)).cmp(&(right * u128::from(scale)))
            }
            FrameTime::BinaryRational {
                significand,
                exponent,
                ..
            } => {
                let left = u128::from(significand) * u128::from(base.denominator);
                if left == 0 || right == 0 {
                    return left.cmp(&right);
                }
                // Compare magnitudes before shifting so subnormals and huge values stay exact.
                let left_bits = 128 - left.leading_zeros() as i32 + i32::from(exponent);
                let right_bits = 128 - right.leading_zeros() as i32;
                match left_bits.cmp(&right_bits) {
                    Ordering::Equal if exponent >= 0 => (left << exponent as u32).cmp(&right),
                    Ordering::Equal => left.cmp(&(right << (-exponent) as u32)),
                    order => order,
                }
            }
        }
    }

    pub(crate) fn select(
        &self,
        frames: &[PresentationFrame],
        base: Timebase,
    ) -> Result<usize, MediaError> {
        Timebase::new(base.numerator, base.denominator)
            .map_err(|e| MediaError::Unsupported(e.to_string()))?;
        let first = frames
            .first()
            .ok_or_else(|| MediaError::Unsupported("empty video frame index".into()))?;
        let (mut low, mut high) = (0, frames.len());
        while low < high {
            let middle = low + (high - low) / 2;
            let relative = frames[middle]
                .best_effort_timestamp
                .checked_sub(first.best_effort_timestamp)
                .and_then(|v| u64::try_from(v).ok())
                .ok_or_else(|| {
                    MediaError::Unsupported("video timestamp ordering overflow".into())
                })?;
            if self.compare(relative, base) == Ordering::Less {
                high = middle;
            } else {
                low = middle + 1;
            }
        }
        let index = low
            .checked_sub(1)
            .ok_or_else(|| MediaError::Unsupported("video request precedes first frame".into()))?;
        let frame = &frames[index];
        let end = frame
            .best_effort_timestamp
            .checked_sub(first.best_effort_timestamp)
            .and_then(|v| v.checked_add(frame.duration))
            .and_then(|v| u64::try_from(v).ok())
            .ok_or_else(|| MediaError::Unsupported("video duration overflow".into()))?;
        if self.compare(end, base) != Ordering::Less {
            return Err(MediaError::Unsupported(
                "video request falls outside a presentation interval".into(),
            ));
        }
        Ok(index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rational_and_binary_boundaries_do_not_round_to_adjacent_frames()
    -> Result<(), Box<dyn std::error::Error>> {
        for denominator in [24_000, 30_000] {
            let base = Timebase::new(1, denominator)?;
            let frames = (0..72)
                .map(|i| PresentationFrame {
                    best_effort_timestamp: 9000 + i * 1001,
                    duration: 1001,
                })
                .collect::<Vec<_>>();
            for i in [0, 1, 11, 12, 23, 24, 47, 48, 70, 71] {
                let rate = aster_render_ir::RationalFrameRate {
                    numerator: denominator,
                    denominator: 1001,
                };
                let time = rate.time_at_frame(i)?;
                assert_eq!(
                    VideoTime::new(FrameTime::Rational {
                        value: time.value,
                        scale: time.scale
                    })?
                    .select(&frames, base)?,
                    i as usize
                );
                let biased = i as f64 * 1001.0 / f64::from(denominator) + 0.0001;
                assert_eq!(
                    VideoTime::new(FrameTime::from_f64(biased)?)?.select(&frames, base)?,
                    i as usize
                );
            }
            let boundary = 1001.0 / f64::from(denominator);
            assert_eq!(
                VideoTime::new(FrameTime::from_f64(f64::from_bits(boundary.to_bits() - 1))?)?
                    .select(&frames, base)?,
                0
            );
            assert_eq!(
                VideoTime::new(FrameTime::from_f64(f64::from_bits(boundary.to_bits() + 1))?)?
                    .select(&frames, base)?,
                1
            );
            assert_eq!(
                VideoTime::new(FrameTime::from_f64(f64::from_bits(1))?)?.select(&frames, base)?,
                0
            );
            assert!(
                VideoTime::new(FrameTime::from_f64(f64::MAX)?)?
                    .select(&frames, base)
                    .is_err()
            );
            assert!(VideoTime::new(FrameTime::from_f64(-0.001)?).is_err());
        }
        Ok(())
    }
}
