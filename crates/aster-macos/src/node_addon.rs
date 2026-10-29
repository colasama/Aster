//! Stable Node-API entry point. Only this optional module depends on the JavaScript host.
use crate::transport::Receiver;
use napi_sys::*;
use std::{
    cell::RefCell,
    ffi::{CStr, CString, c_void},
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
    sync::Once,
};

struct Call {
    env: napi_env,
    args: Vec<napi_value>,
}

impl Call {
    unsafe fn invoke(
        env: napi_env,
        info: napi_callback_info,
        count: usize,
        action: impl FnOnce(&Self) -> Result<napi_value, String>,
    ) -> napi_value {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let mut args = vec![ptr::null_mut(); count + 1];
            let mut actual = args.len();
            Self::check(unsafe {
                napi_get_cb_info(
                    env,
                    info,
                    &mut actual,
                    args.as_mut_ptr(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            })?;
            if actual != count {
                return Err("invalid native surface arguments".into());
            }
            action(&Self { env, args })
        }));
        match result {
            Ok(Ok(value)) => value,
            error => {
                let message = match error {
                    Ok(Err(message)) => message,
                    _ => "native surface operation panicked".into(),
                };
                let message = CString::new(message.replace('\0', " ")).ok();
                unsafe {
                    napi_throw_error(
                        env,
                        ptr::null(),
                        message
                            .as_ref()
                            .map_or(c"native surface error".as_ptr(), |message| message.as_ptr()),
                    );
                }
                ptr::null_mut()
            }
        }
    }

    fn check(status: napi_status) -> Result<(), String> {
        if status != Status::napi_ok {
            return Err(format!("Node-API operation failed: {status}"));
        }
        Ok(())
    }

    fn number(&self, index: usize) -> Result<u64, String> {
        let mut value = 0.0;
        Self::check(unsafe { napi_get_value_double(self.env, self.args[index], &mut value) })?;
        if !(1.0..=9_007_199_254_740_991.0).contains(&value) || value.fract() != 0.0 {
            return Err("invalid surface lease identity".into());
        }
        Ok(value as u64)
    }

    fn receiver(&self) -> Result<&RefCell<Receiver>, String> {
        let mut pointer = ptr::null_mut();
        Self::check(unsafe { napi_get_value_external(self.env, self.args[0], &mut pointer) })?;
        // Externals are created below and remain rooted by the callback's argument list.
        unsafe { pointer.cast::<RefCell<Receiver>>().as_ref() }
            .ok_or_else(|| "invalid surface receiver".into())
    }

    fn undefined(&self) -> Result<napi_value, String> {
        let mut result = ptr::null_mut();
        Self::check(unsafe { napi_get_undefined(self.env, &mut result) })?;
        Ok(result)
    }

    unsafe extern "C" fn finalize(_: napi_env, pointer: *mut c_void, _: *mut c_void) {
        // Node calls the finalizer once, after the external is no longer reachable.
        if !pointer.is_null() {
            drop(unsafe { Box::from_raw(pointer.cast::<RefCell<Receiver>>()) });
        }
    }

    unsafe extern "C" fn open(env: napi_env, info: napi_callback_info) -> napi_value {
        unsafe {
            Self::invoke(env, info, 1, |call| {
                let mut bytes = [0u8; 102];
                let mut length = 0;
                Self::check(napi_get_value_string_utf8(
                    env,
                    call.args[0],
                    bytes.as_mut_ptr().cast(),
                    bytes.len(),
                    &mut length,
                ))?;
                if length > 100 {
                    return Err("private Mach service name is too long".into());
                }
                let service =
                    std::str::from_utf8(&bytes[..length]).map_err(|error| error.to_string())?;
                let receiver = Box::into_raw(Box::new(RefCell::new(Receiver::open(service)?)));
                let mut value = ptr::null_mut();
                if let Err(error) = Self::check(napi_create_external(
                    env,
                    receiver.cast(),
                    Some(Self::finalize),
                    ptr::null_mut(),
                    &mut value,
                )) {
                    drop(Box::from_raw(receiver));
                    return Err(error);
                }
                Ok(value)
            })
        }
    }

    unsafe extern "C" fn receive(env: napi_env, info: napi_callback_info) -> napi_value {
        unsafe {
            Self::invoke(env, info, 5, |call| {
                let mut receiver = call
                    .receiver()?
                    .try_borrow_mut()
                    .map_err(|_| "surface receiver is busy")?;
                let sequence = call.number(2)?;
                let bytes = receiver.receive(
                    call.number(1)?,
                    sequence,
                    call.number(3)?,
                    call.number(4)?,
                )?;
                let mut value = ptr::null_mut();
                if let Err(error) = Self::check(napi_create_buffer_copy(
                    env,
                    bytes.len(),
                    bytes.as_ptr().cast(),
                    ptr::null_mut(),
                    &mut value,
                )) {
                    receiver.release(sequence);
                    return Err(error);
                }
                Ok(value)
            })
        }
    }

    unsafe extern "C" fn release(env: napi_env, info: napi_callback_info) -> napi_value {
        unsafe {
            Self::invoke(env, info, 2, |call| {
                call.receiver()?
                    .try_borrow_mut()
                    .map_err(|_| "surface receiver is busy")?
                    .release(call.number(1)?);
                call.undefined()
            })
        }
    }

    unsafe extern "C" fn close(env: napi_env, info: napi_callback_info) -> napi_value {
        unsafe {
            Self::invoke(env, info, 1, |call| {
                call.receiver()?
                    .try_borrow_mut()
                    .map_err(|_| "surface receiver is busy")?
                    .close();
                call.undefined()
            })
        }
    }

    unsafe fn register(env: napi_env, exports: napi_value) -> napi_value {
        static INITIALIZE: Once = Once::new();
        // Resolve Node-API only when Electron loads this cdylib. Rust binaries/tests need no host.
        INITIALIZE.call_once(|| std::mem::forget(unsafe { napi_sys::setup() }));
        let methods: [(&CStr, napi_callback); 4] = [
            (c"open", Some(Self::open)),
            (c"receive", Some(Self::receive)),
            (c"release", Some(Self::release)),
            (c"close", Some(Self::close)),
        ];
        let descriptors = methods.map(|(name, method)| napi_property_descriptor {
            utf8name: name.as_ptr(),
            name: ptr::null_mut(),
            method,
            getter: None,
            setter: None,
            value: ptr::null_mut(),
            attributes: PropertyAttributes::default,
            data: ptr::null_mut(),
        });
        if unsafe { napi_define_properties(env, exports, descriptors.len(), descriptors.as_ptr()) }
            != Status::napi_ok
        {
            unsafe {
                napi_throw_error(env, ptr::null(), c"cannot register surface bridge".as_ptr());
            }
            return ptr::null_mut();
        }
        exports
    }
}

// Node's ABI requires this exact exported symbol; all operations live on Call.
#[unsafe(no_mangle)]
unsafe extern "C" fn napi_register_module_v1(env: napi_env, exports: napi_value) -> napi_value {
    unsafe { Call::register(env, exports) }
}
