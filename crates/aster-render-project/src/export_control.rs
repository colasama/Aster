use crate::ProjectRenderError;
use aster_video::CancellationToken;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[derive(Clone, Default)]
pub struct ProjectExportControl {
    pub cancellation: CancellationToken,
    state: Arc<(Mutex<PauseState>, Condvar)>,
    pause_observer: Option<Arc<dyn Fn(Option<u64>) + Send + Sync>>,
}

#[derive(Default)]
struct PauseState {
    paused: bool,
    request_id: Option<u64>,
    pending_notice: bool,
}

impl ProjectExportControl {
    /// Install before cloning controls. Notifications run at processing boundaries, outside the lock.
    pub fn with_pause_observer(
        mut self,
        observer: impl Fn(Option<u64>) + Send + Sync + 'static,
    ) -> Self {
        self.pause_observer = Some(Arc::new(observer));
        self
    }

    pub fn pause(&self, paused: bool, request_id: Option<u64>) -> Result<(), ProjectRenderError> {
        let mut state = self
            .state
            .0
            .lock()
            .map_err(|_| ProjectRenderError::Invalid("export control poisoned".into()))?;
        *state = PauseState {
            paused,
            request_id,
            pending_notice: paused,
        };
        self.state.1.notify_all();
        Ok(())
    }

    pub fn wait(&self) -> Result<(), ProjectRenderError> {
        let mut state = self
            .state
            .0
            .lock()
            .map_err(|_| ProjectRenderError::Invalid("export control poisoned".into()))?;
        loop {
            if self.cancellation.is_cancelled() {
                return Err(aster_video::FfmpegError::Cancelled.into());
            }
            if !state.paused {
                return Ok(());
            }
            if state.pending_notice {
                let request_id = state.request_id;
                state.pending_notice = false;
                drop(state);
                if let Some(observer) = &self.pause_observer {
                    observer(request_id);
                }
                state =
                    self.state.0.lock().map_err(|_| {
                        ProjectRenderError::Invalid("export control poisoned".into())
                    })?;
                continue;
            }
            state = self
                .state
                .1
                .wait_timeout(state, Duration::from_millis(50))
                .map_err(|_| ProjectRenderError::Invalid("export control poisoned".into()))?
                .0;
        }
    }
}
