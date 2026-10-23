use aster_eval::FramePlanRequest;
use aster_render_ir::RationalFrameRate;

/// A time-addressable export clock whose resident storage does not depend on job length.
#[derive(Clone)]
pub struct ProjectExportFrames {
    pub(crate) template: FramePlanRequest,
    pub(crate) rate: RationalFrameRate,
    pub(crate) start_frame: Option<u64>,
    pub(crate) count: usize,
}

impl ProjectExportFrames {
    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub fn first(&self) -> Option<FramePlanRequest> {
        self.get(0)
    }

    pub fn get(&self, index: usize) -> Option<FramePlanRequest> {
        // Range::nth advances directly; random access never walks preceding export frames.
        if index >= self.count {
            return None;
        }
        self.iter().nth(index)
    }

    pub fn iter(&self) -> impl ExactSizeIterator<Item = FramePlanRequest> + '_ {
        (0..self.count).map(|index| {
            let mut frame = self.template.clone();
            frame.time = self.start_frame.map_or_else(
                || {
                    self.template.time
                        + index as f64 * f64::from(self.rate.denominator)
                            / f64::from(self.rate.numerator)
                },
                |first| {
                    (first + index as u64) as f64 * f64::from(self.rate.denominator)
                        / f64::from(self.rate.numerator)
                },
            );
            frame
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aster_render_ir::{AntiAliasing, Extent2d};

    #[test]
    fn ten_million_frame_clock_preserves_absolute_bits_and_constant_storage()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut frames = ProjectExportFrames {
            template: FramePlanRequest {
                snapshot_scope: "immutable".into(),
                project_revision: 0,
                composition_id: "main".into(),
                time: 0.0,
                target: Extent2d {
                    width: 320,
                    height: 180,
                },
                render_target: Extent2d {
                    width: 320,
                    height: 180,
                },
                anti_aliasing: AntiAliasing::Off,
                shadows_enabled: true,
            },
            rate: RationalFrameRate {
                numerator: 30000,
                denominator: 1001,
            },
            start_frame: Some(17),
            count: 1,
        };
        let storage = std::mem::size_of_val(&frames);
        frames.count = 10_000_000;
        assert_eq!(std::mem::size_of_val(&frames), storage);
        assert_eq!(frames.iter().len(), 10_000_000);
        for index in [0, 1, 65_535, 65_536, 9_999_999] {
            let frame = frames.get(index).ok_or("missing frame")?;
            assert_eq!(
                frame.time.to_bits(),
                ((17 + index) as f64 * 1001.0 / 30000.0).to_bits()
            );
            assert_eq!(frame.snapshot_scope, "immutable");
        }
        assert!(frames.get(10_000_000).is_none());
        frames.start_frame = None;
        frames.template.time = 0.123;
        assert_eq!(
            frames.get(9_999_999).ok_or("last frame")?.time.to_bits(),
            (0.123 + 9_999_999_f64 * 1001.0 / 30000.0).to_bits()
        );
        Ok(())
    }
}
