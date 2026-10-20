use crate::{ProjectError, ProjectMediaStorage};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSequenceFrame {
    pub frame: i64,
    pub name: String,
    pub size: u64,
    pub last_modified: u64,
    #[serde(rename = "type")]
    pub mime_type: String,
    pub storage: ProjectMediaStorage,
}

#[derive(Clone, Deserialize)]
pub struct SequenceRate {
    pub numerator: u64,
    pub denominator: u64,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MissingSequenceFrame {
    Error,
    HoldPrevious,
    Nearest,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSequence {
    pub id: String,
    pub content_identity: String,
    pub pattern: String,
    pub prefix: String,
    pub extension: String,
    pub padding: usize,
    pub start_frame: i64,
    pub end_frame: i64,
    pub missing_frames: Vec<i64>,
    pub frame_rate: SequenceRate,
    pub missing_frame_policy: MissingSequenceFrame,
    #[serde(rename = "loop")]
    pub looping: bool,
    pub frames: Vec<ProjectSequenceFrame>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct SequenceSelection {
    pub requested_frame: i64,
    pub actual_frame: i64,
    pub missing: bool,
}

impl ProjectSequence {
    pub(super) fn validate(&mut self, max_frames: usize) -> Result<(), ProjectError> {
        if self.frames.is_empty()
            || self.frames.len() > max_frames
            || self.missing_frames.len() > max_frames
            || self.start_frame < 0
            || self.end_frame > 1_000_000_000
            || self.end_frame < self.start_frame
            || !(1..=32).contains(&self.padding)
            || self.prefix.encode_utf16().count() > 1024
            || self.extension.is_empty()
            || self.extension.encode_utf16().count() > 32
            || self.frame_rate.numerator == 0
            || self.frame_rate.numerator > 9_007_199_254_740_991
            || self.frame_rate.denominator == 0
            || self.frame_rate.denominator > 9_007_199_254_740_991
        {
            return Err(ProjectError::InvalidMedia(
                "bounded sequence settings required",
            ));
        }
        if self.pattern
            != format!(
                "{}[{}]{}",
                self.prefix,
                "#".repeat(self.padding),
                self.extension
            )
            || self.frames.first().map(|f| f.frame) != Some(self.start_frame)
            || self.frames.last().map(|f| f.frame) != Some(self.end_frame)
            || self.frames.windows(2).any(|f| f[0].frame >= f[1].frame)
        {
            return Err(ProjectError::InvalidMedia(
                "sequence pattern, bounds or authored frame order differs",
            ));
        }
        let mut present = BTreeSet::new();
        for frame in &self.frames {
            let Some((stem, extension)) = frame.name.rsplit_once('.') else {
                return Err(ProjectError::InvalidMedia("sequence file extension absent"));
            };
            let digit_start = stem.trim_end_matches(|c: char| c.is_ascii_digit()).len();
            let (prefix, digits) = stem.split_at(digit_start);
            if prefix != self.prefix
                || format!(".{extension}").to_lowercase() != self.extension.to_lowercase()
                || digits.len() != self.padding
                || digits.parse::<i64>().ok() != Some(frame.frame)
                || frame.frame < self.start_frame
                || frame.frame > self.end_frame
                || frame.size > 2_147_483_648
                || frame.last_modified > 9_007_199_254_740_991
            {
                return Err(ProjectError::InvalidMedia(
                    "sequence member metadata differs",
                ));
            }
            present.insert(frame.frame);
        }
        let missing: BTreeSet<_> = self.missing_frames.iter().copied().collect();
        if missing.len() != self.missing_frames.len()
            || missing
                .iter()
                .any(|f| *f < self.start_frame || *f > self.end_frame || present.contains(f))
            || present.len() + missing.len() != (self.end_frame - self.start_frame + 1) as usize
        {
            return Err(ProjectError::InvalidMedia(
                "sequence missing-frame inventory differs",
            ));
        }
        Ok(())
    }

    pub fn select(&self, time: f64) -> Result<SequenceSelection, ProjectError> {
        if !time.is_finite()
            || self.frame_rate.numerator == 0
            || self.frame_rate.denominator == 0
            || self.frames.is_empty()
            || self.start_frame < 0
            || self.end_frame > 1_000_000_000
            || self.end_frame < self.start_frame
        {
            return Err(ProjectError::InvalidMedia(
                "finite sequence time and admitted frames required",
            ));
        }
        let elapsed = (time.max(0.0) * self.frame_rate.numerator as f64
            / self.frame_rate.denominator as f64
            + 1e-9)
            .floor()
            .max(0.0);
        if !elapsed.is_finite() {
            return Err(ProjectError::InvalidMedia("sequence time overflow"));
        }
        let length = (self.end_frame - self.start_frame + 1).max(1) as f64;
        let requested = if self.looping {
            self.start_frame as f64 + elapsed % length
        } else {
            (self.start_frame as f64 + elapsed).min(self.end_frame as f64)
        } as i64;
        match self.frames.binary_search_by_key(&requested, |f| f.frame) {
            Ok(_) => Ok(SequenceSelection {
                requested_frame: requested,
                actual_frame: requested,
                missing: false,
            }),
            Err(index) => {
                if matches!(self.missing_frame_policy, MissingSequenceFrame::Error) {
                    return Err(ProjectError::InvalidMedia(
                        "requested sequence frame is missing",
                    ));
                }
                let before = &self.frames[index.saturating_sub(1).min(self.frames.len() - 1)];
                let after = &self.frames[index.min(self.frames.len() - 1)];
                let frame = if matches!(
                    self.missing_frame_policy,
                    MissingSequenceFrame::HoldPrevious
                ) || (requested - before.frame).abs()
                    <= (requested - after.frame).abs()
                {
                    before.frame
                } else {
                    after.frame
                };
                Ok(SequenceSelection {
                    requested_frame: requested,
                    actual_frame: frame,
                    missing: true,
                })
            }
        }
    }
}
