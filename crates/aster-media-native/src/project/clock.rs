use crate::MediaError;
use aster_render_ir::{FrameTime, MediaSample, ResourceHash};
use std::collections::BTreeMap;

pub(super) struct ProjectVideoClock {
    instances: BTreeMap<String, (ResourceHash, f64)>,
    capacity: usize,
}

impl ProjectVideoClock {
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            instances: BTreeMap::new(),
            capacity,
        }
    }

    pub(super) fn sample(
        &self,
        instance: &str,
        source: &ResourceHash,
        time: f64,
        duration: f64,
        playing: bool,
    ) -> Result<MediaSample, MediaError> {
        if instance.is_empty()
            || instance.len() > 4096
            || !time.is_finite()
            || !duration.is_finite()
            || duration < 0.0
            || (!self.instances.contains_key(instance) && self.instances.len() >= self.capacity)
        {
            return Err(MediaError::Limit(
                "bounded video instances and finite source clocks required".into(),
            ));
        }
        let last = (duration - 0.001).max(0.0);
        let source_time = time.max(0.0).min(last);
        let requested = if playing {
            source_time
        } else {
            (source_time + 0.0001).min(last)
        };
        let previous = self
            .instances
            .get(instance)
            .filter(|(identity, _)| identity == source)
            .map_or(0.0, |(_, time)| *time);
        let tolerance = if playing { 0.12 } else { 1.0 / 240.0 };
        let uploaded = if (previous - requested).abs() > tolerance {
            (requested * 1_000_000.0).trunc() / 1_000_000.0
        } else {
            previous
        };
        Ok(MediaSample::Video {
            requested_time: FrameTime::from_f64(requested)?,
            uploaded_time: FrameTime::from_f64(uploaded)?,
        })
    }

    pub(super) fn commit(
        &mut self,
        instance: &str,
        source: &ResourceHash,
        sample: &MediaSample,
    ) -> Result<(), MediaError> {
        if let MediaSample::Video { uploaded_time, .. } = sample {
            self.instances.insert(
                instance.to_owned(),
                (source.clone(), uploaded_time.to_f64()?),
            );
        }
        Ok(())
    }
}
