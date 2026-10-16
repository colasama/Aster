use aster_render_ir::RationalFrameRate;

use crate::{EncodeError, PacketMetadata};

pub(crate) struct FrameClock;

impl FrameClock {
    pub(crate) fn at(rate: RationalFrameRate, frame: u64) -> Result<PacketMetadata, EncodeError> {
        rate.validate()?;
        let end = frame
            .checked_add(1)
            .ok_or_else(|| EncodeError::Invalid("frame index overflow".into()))?;
        let ticks = |index| -> Result<i64, EncodeError> {
            i64::try_from(
                u128::from(index) * 10_000_000 * u128::from(rate.denominator)
                    / u128::from(rate.numerator),
            )
            .map_err(|_| EncodeError::Invalid("frame timestamp overflow".into()))
        };
        let timestamp_100ns = ticks(frame)?;
        Ok(PacketMetadata {
            frame_index: frame,
            timestamp_100ns,
            duration_100ns: ticks(end)? - timestamp_100ns,
            payload_bytes: 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fractional_frame_durations_sum_without_drift() -> Result<(), EncodeError> {
        let rate = RationalFrameRate {
            numerator: 30000,
            denominator: 1001,
        };
        let frames = (0..30000)
            .map(|index| FrameClock::at(rate, index))
            .collect::<Result<Vec<_>, _>>()?;
        assert_eq!(
            frames.iter().map(|f| f.duration_100ns).sum::<i64>(),
            10_010_000_000
        );
        assert!(
            frames
                .windows(2)
                .all(|f| f[0].timestamp_100ns + f[0].duration_100ns == f[1].timestamp_100ns)
        );
        assert!(FrameClock::at(rate, u64::MAX).is_err());
        assert!(
            FrameClock::at(
                RationalFrameRate {
                    numerator: 1,
                    denominator: 1
                },
                u64::MAX / 2
            )
            .is_err()
        );
        Ok(())
    }
}
