use crate::ProjectRenderError;
use aster_video::CancellationToken;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[derive(Clone, Default)]
pub struct ProjectExportControl {
    pub cancellation: CancellationToken,
    state: Arc<(Mutex<bool>, Condvar)>,
}

impl ProjectExportControl {
    pub fn pause(&self, paused: bool) -> Result<(), ProjectRenderError> {
        let mut state = self
            .state
            .0
            .lock()
            .map_err(|_| ProjectRenderError::Invalid("export control poisoned".into()))?;
        *state = paused;
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
            if !*state {
                return Ok(());
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
