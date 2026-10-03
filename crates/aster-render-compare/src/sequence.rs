use serde::Serialize;

use crate::{error::CompareError, image::RgbaImage, metrics::Metrics};

#[derive(Debug)]
pub struct SequenceInput {
    pub frame: u64,
    pub first_frame: u64,
    pub last_frame: u64,
    pub previous: Option<RgbaImage>,
    pub next: Option<RgbaImage>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum NeighborReport {
    OutsideDomain,
    Compared {
        frame: u64,
        mean_squared_error: f64,
        current_is_closer: bool,
    },
}

#[derive(Debug, Serialize)]
pub struct SequenceReport {
    pub frame: u64,
    pub first_frame: u64,
    pub last_frame: u64,
    pub current_mean_squared_error: f64,
    pub previous: NeighborReport,
    pub next: NeighborReport,
    pub passed: bool,
}

impl SequenceInput {
    pub fn measure(
        &self,
        reference: &RgbaImage,
        candidate: &RgbaImage,
    ) -> Result<SequenceReport, CompareError> {
        if self.first_frame >= self.last_frame
            || self.frame < self.first_frame
            || self.frame > self.last_frame
        {
            return Err(CompareError::InvalidArgument(
                "Sequence needs a valid multi-frame domain containing the requested frame".into(),
            ));
        }
        if self.previous.is_some() != (self.frame > self.first_frame)
            || self.next.is_some() != (self.frame < self.last_frame)
        {
            return Err(CompareError::InvalidArgument(
                "Sequence neighbors must be supplied exactly for frames inside the declared domain"
                    .into(),
            ));
        }
        let current = Metrics::measure(reference, candidate, None)?.mean_squared_error;
        let mut passed = true;
        let previous = if let Some(image) = &self.previous {
            let error = Metrics::measure(image, candidate, None)?.mean_squared_error;
            passed &= current < error;
            NeighborReport::Compared {
                frame: self.frame - 1,
                mean_squared_error: error,
                current_is_closer: current < error,
            }
        } else {
            NeighborReport::OutsideDomain
        };
        let next = if let Some(image) = &self.next {
            let error = Metrics::measure(image, candidate, None)?.mean_squared_error;
            passed &= current < error;
            NeighborReport::Compared {
                frame: self.frame + 1,
                mean_squared_error: error,
                current_is_closer: current < error,
            }
        } else {
            NeighborReport::OutsideDomain
        };
        Ok(SequenceReport {
            frame: self.frame,
            first_frame: self.first_frame,
            last_frame: self.last_frame,
            current_mean_squared_error: current,
            previous,
            next,
            passed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_requires_strictly_better_correct_frame() -> Result<(), CompareError> {
        let previous = RgbaImage::new(1, 1, vec![0, 0, 0, 255])?;
        let current = RgbaImage::new(1, 1, vec![10, 0, 0, 255])?;
        let next = RgbaImage::new(1, 1, vec![20, 0, 0, 255])?;
        let input = SequenceInput {
            frame: 1,
            first_frame: 0,
            last_frame: 2,
            previous: Some(previous.clone()),
            next: Some(next),
        };
        assert!(input.measure(&current, &current)?.passed);
        assert!(!input.measure(&current, &previous)?.passed);
        let tie = RgbaImage::new(1, 1, vec![5, 0, 0, 255])?;
        assert!(!input.measure(&current, &tie)?.passed);
        Ok(())
    }

    #[test]
    fn missing_neighbor_is_not_a_pass() -> Result<(), CompareError> {
        let image = RgbaImage::new(1, 1, vec![0, 0, 0, 255])?;
        let mut input = SequenceInput {
            frame: 1,
            first_frame: 0,
            last_frame: 2,
            previous: None,
            next: Some(image.clone()),
        };
        assert!(input.measure(&image, &image).is_err());
        input.frame = 0;
        assert!(!input.measure(&image, &image)?.passed);
        input.next = Some(RgbaImage::new(1, 1, vec![1, 0, 0, 255])?);
        assert!(input.measure(&image, &image)?.passed);
        input.last_frame = 0;
        assert!(input.measure(&image, &image).is_err());
        Ok(())
    }
}
