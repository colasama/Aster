use std::sync::{Arc, Mutex, Weak};

use windows::{
    Win32::{
        Foundation::{E_NOTIMPL, E_UNEXPECTED},
        Media::MediaFoundation::*,
    },
    core::{Interface, Ref, implement},
};

/// One outstanding asynchronous request bounds event storage independently of frame count.
pub(crate) struct MfEvents {
    generator: IMFMediaEventGenerator,
    callback: IMFAsyncCallback,
    result: Arc<Mutex<Option<windows::core::Result<u32>>>>,
}

#[implement(IMFAsyncCallback)]
struct EventReady {
    result: Weak<Mutex<Option<windows::core::Result<u32>>>>,
}

impl IMFAsyncCallback_Impl for EventReady_Impl {
    fn GetParameters(&self, _flags: *mut u32, _queue: *mut u32) -> windows::core::Result<()> {
        Err(windows::core::Error::from_hresult(E_NOTIMPL))
    }

    fn Invoke(&self, result: Ref<IMFAsyncResult>) -> windows::core::Result<()> {
        let Some(state) = self.result.upgrade() else {
            return Ok(());
        };
        let mut pending = state
            .lock()
            .map_err(|_| windows::core::Error::from_hresult(E_UNEXPECTED))?;
        if pending.is_some() {
            return Err(windows::core::Error::from_hresult(E_UNEXPECTED));
        }
        *pending = Some((|| unsafe {
            let result = result
                .as_ref()
                .ok_or_else(|| windows::core::Error::from_hresult(E_UNEXPECTED))?;
            let generator: IMFMediaEventGenerator = result.GetState()?.cast()?;
            let event = generator.EndGetEvent(result)?;
            event.GetStatus()?.ok()?;
            event.GetType()
        })());
        Ok(())
    }
}

impl MfEvents {
    pub(crate) fn new(transform: &IMFTransform) -> windows::core::Result<Self> {
        let generator: IMFMediaEventGenerator = transform.cast()?;
        let result = Arc::new(Mutex::new(None));
        let callback: IMFAsyncCallback = EventReady {
            result: Arc::downgrade(&result),
        }
        .into();
        unsafe {
            generator.BeginGetEvent(&callback, &generator)?;
        }
        Ok(Self {
            generator,
            callback,
            result,
        })
    }

    pub(crate) fn poll(&self) -> windows::core::Result<Option<u32>> {
        let pending = self
            .result
            .lock()
            .map_err(|_| windows::core::Error::from_hresult(E_UNEXPECTED))?
            .take();
        let Some(pending) = pending else {
            return Ok(None);
        };
        unsafe {
            self.generator
                .BeginGetEvent(&self.callback, &self.generator)?;
            Ok(Some(pending?))
        }
    }
}
