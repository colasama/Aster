use aster_video::{CancellationToken, FfmpegError};
use std::{
    thread::{self, JoinHandle},
    time::Duration,
};

/// One complete decode; ownership includes cancellation and joining its process readers.
pub(crate) struct VideoPrefetch {
    pub(crate) first: usize,
    pub(crate) count: usize,
    cancellation: CancellationToken,
    task: Option<JoinHandle<Result<Vec<u8>, FfmpegError>>>,
}

impl VideoPrefetch {
    pub(crate) fn spawn(
        first: usize,
        count: usize,
        decode: impl FnOnce(CancellationToken) -> Result<Vec<u8>, FfmpegError> + Send + 'static,
    ) -> Result<Self, FfmpegError> {
        let cancellation = CancellationToken::default();
        let worker_cancellation = cancellation.clone();
        let task = thread::Builder::new()
            .name("aster-video-prefetch".into())
            .spawn(move || decode(worker_cancellation))
            .map_err(|error| FfmpegError::ProcessIo(error.to_string()))?;
        Ok(Self {
            first,
            count,
            cancellation,
            task: Some(task),
        })
    }

    pub(crate) fn finish(
        mut self,
        cancellation: &CancellationToken,
    ) -> Result<Vec<u8>, FfmpegError> {
        let task = self
            .task
            .take()
            .ok_or_else(|| FfmpegError::ProcessIo("video prefetch already consumed".into()))?;
        while !task.is_finished() {
            if cancellation.is_cancelled() {
                self.cancellation.cancel();
            }
            thread::sleep(Duration::from_millis(2));
        }
        let result = task
            .join()
            .map_err(|_| FfmpegError::ProcessIo("video prefetch panicked".into()))?;
        if cancellation.is_cancelled() {
            return Err(FfmpegError::Cancelled);
        }
        result
    }
}

impl Drop for VideoPrefetch {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::VideoPrefetch;
    use aster_video::{CancellationToken, FfmpegError};
    use std::{
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        thread,
        time::Duration,
    };

    #[test]
    fn complete_decode_is_owned_and_failures_do_not_publish_bytes() -> Result<(), FfmpegError> {
        let request = CancellationToken::default();
        let ready = VideoPrefetch::spawn(8, 2, |_| Ok(vec![1, 2, 3]))?;
        assert_eq!(ready.finish(&request)?, vec![1, 2, 3]);
        let failed = VideoPrefetch::spawn(8, 2, |_| {
            Err(FfmpegError::InvalidMetadata("late decode error".into()))
        })?;
        assert!(failed.finish(&request).is_err());
        Ok(())
    }

    #[test]
    fn cancellation_and_drop_join_pending_work() -> Result<(), FfmpegError> {
        for consume in [false, true] {
            let stopped = Arc::new(AtomicBool::new(false));
            let worker_stopped = Arc::clone(&stopped);
            let pending = VideoPrefetch::spawn(8, 2, move |cancellation| {
                while !cancellation.is_cancelled() {
                    thread::sleep(Duration::from_millis(1));
                }
                worker_stopped.store(true, Ordering::Release);
                Err(FfmpegError::Cancelled)
            })?;
            if consume {
                let request = CancellationToken::default();
                request.cancel();
                assert!(matches!(
                    pending.finish(&request),
                    Err(FfmpegError::Cancelled)
                ));
            } else {
                drop(pending);
            }
            assert!(stopped.load(Ordering::Acquire));
        }
        Ok(())
    }
}
