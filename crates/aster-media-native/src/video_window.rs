use crate::{MediaError, video_prefetch::VideoPrefetch};
use aster_render_ir::ResourceHash;
use aster_video::{CancellationToken, FfmpegBackend, VideoSnapshot};
use serde::Serialize;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct VideoWindowStatistics {
    pub processes: u64,
    pub hits: u64,
    pub resident_bytes: u64,
    pub frames: usize,
    pub prefetches: u64,
    pub prefetch_hits: u64,
    pub pending_bytes: u64,
    pub pending_frames: usize,
}

/// Current and pending source windows share one bounded allocation allowance.
pub(crate) struct VideoDecodeWindow {
    source: Option<ResourceHash>,
    first: usize,
    frame_bytes: usize,
    bytes: Vec<u8>,
    pending: Option<VideoPrefetch>,
    stats: VideoWindowStatistics,
    byte_limit: u64,
    frame_limit: usize,
    prefetch: bool,
}

impl VideoDecodeWindow {
    pub(crate) fn new(byte_limit: u64, frame_limit: usize, prefetch: bool) -> Self {
        Self {
            source: None,
            first: 0,
            frame_bytes: 0,
            bytes: Vec::new(),
            pending: None,
            stats: VideoWindowStatistics::default(),
            byte_limit,
            frame_limit,
            prefetch,
        }
    }

    pub(crate) fn statistics(&self) -> VideoWindowStatistics {
        self.stats
    }

    pub(crate) fn clear(&mut self) {
        self.pending = None;
        self.bytes = Vec::new();
        self.source = None;
        self.stats.resident_bytes = 0;
        self.stats.frames = 0;
        self.stats.pending_bytes = 0;
        self.stats.pending_frames = 0;
    }

    pub(crate) fn discard_other_source(&mut self, source: &ResourceHash) {
        // Release the pending snapshot before the source cache can evict its accounting entry.
        if self
            .source
            .as_ref()
            .is_some_and(|current| current != source)
        {
            self.clear();
        }
    }

    pub(crate) fn decode(
        &mut self,
        source: &ResourceHash,
        snapshot: &Arc<VideoSnapshot>,
        index: usize,
        decoder: &FfmpegBackend,
        cancellation: &CancellationToken,
        source_retained: bool,
    ) -> Result<Vec<u8>, MediaError> {
        if cancellation.is_cancelled() {
            self.clear();
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        if self.source.as_ref() == Some(source)
            && index >= self.first
            && index - self.first < self.stats.frames
        {
            self.stats.hits = self.stats.hits.saturating_add(1);
            let offset = (index - self.first) * self.frame_bytes;
            return Ok(self.bytes[offset..offset + self.frame_bytes].to_vec());
        }
        let size = u64::from(snapshot.stream.width) * u64::from(snapshot.stream.height) * 4;
        if size == 0 || index >= snapshot.frames.len() {
            self.clear();
            return Err(MediaError::Limit(
                "invalid video window extent or index".into(),
            ));
        }
        let capacity = (self.byte_limit / size).min(self.frame_limit as u64).max(1) as usize;
        let reusable = self.source.as_ref() == Some(source)
            && self.pending.as_ref().is_some_and(|pending| {
                index >= pending.first && index - pending.first < pending.count
            });
        let pending = if reusable { self.pending.take() } else { None };
        // Release both the previous allocation and any abandoned work before replacement.
        self.clear();
        let (first, count, bytes) = if let Some(pending) = pending {
            let first = pending.first;
            let count = pending.count;
            let bytes = pending.finish(cancellation)?;
            self.stats.prefetch_hits = self.stats.prefetch_hits.saturating_add(1);
            (first, count, bytes)
        } else {
            let remaining = snapshot.frames.len() - index;
            let count = if self.prefetch && source_retained && capacity >= 4 && remaining > capacity
            {
                capacity / 2
            } else {
                capacity.min(remaining)
            };
            self.stats.processes = self.stats.processes.saturating_add(1);
            (
                index,
                count,
                decoder.decode_snapshot_frames(snapshot, index, count, cancellation)?,
            )
        };
        let frame_bytes = usize::try_from(size)
            .map_err(|_| MediaError::Limit("video frame size overflow".into()))?;
        if count == 1 {
            return Ok(bytes);
        }
        let offset = (index - first) * frame_bytes;
        let result = bytes[offset..offset + frame_bytes].to_vec();
        self.stats.resident_bytes = bytes.len() as u64;
        self.stats.frames = count;
        self.source = Some(source.clone());
        self.first = first;
        self.frame_bytes = frame_bytes;
        self.bytes = bytes;
        let next = first + count;
        if self.prefetch && source_retained && capacity >= 4 && next < snapshot.frames.len() {
            let count = (capacity / 2)
                .min(capacity - count)
                .min(snapshot.frames.len() - next);
            if count > 0 {
                let snapshot = Arc::clone(snapshot);
                let decoder = decoder.clone();
                // Failure to create speculative work leaves the synchronous path available.
                if let Ok(pending) = VideoPrefetch::spawn(next, count, move |cancellation| {
                    decoder.decode_snapshot_frames(&snapshot, next, count, &cancellation)
                }) {
                    self.stats.processes = self.stats.processes.saturating_add(1);
                    self.stats.prefetches = self.stats.prefetches.saturating_add(1);
                    self.stats.pending_bytes = count as u64 * size;
                    self.stats.pending_frames = count;
                    self.pending = Some(pending);
                }
            }
        }
        Ok(result)
    }
}
