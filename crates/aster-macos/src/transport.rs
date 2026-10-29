use mach2::{
    bootstrap::{bootstrap_look_up, bootstrap_port},
    mach_port::*,
    message::*,
    port::*,
    traps::mach_task_self,
};
use objc2_io_surface::IOSurfaceRef;
use std::{ffi::CString, mem::size_of};
#[cfg(feature = "node-addon")]
use {objc2_core_foundation::CFRetained, std::collections::BTreeMap};

#[cfg(feature = "node-addon")]
use mach2::bootstrap::bootstrap_register;

#[repr(C)]
#[derive(Default)]
pub(crate) struct SurfaceMessage {
    header: mach_msg_header_t,
    body: mach_msg_body_t,
    surface: mach_msg_port_descriptor_t,
    sequence: u64,
}

impl SurfaceMessage {
    fn service_name(service: &str) -> Result<CString, String> {
        if !service.starts_with("io.aster.preview.") || service.len() > 100 {
            return Err("invalid private preview destination".into());
        }
        CString::new(service).map_err(|error| error.to_string())
    }

    pub(crate) fn send(surface: &IOSurfaceRef, service: &str, sequence: u64) -> Result<(), String> {
        let service = Self::service_name(service)?;
        if sequence == 0 {
            return Err("invalid surface sequence".into());
        }
        let mut destination = MACH_PORT_NULL;
        // Both send rights are owned locally and released on every exit, including timeout.
        unsafe {
            let status = bootstrap_look_up(bootstrap_port, service.as_ptr(), &mut destination);
            if status != 0 {
                return Err(format!("Mach destination lookup failed: {status}"));
            }
            let port = surface.create_mach_port();
            if port == MACH_PORT_NULL || port == MACH_PORT_DEAD {
                mach_port_deallocate(mach_task_self(), destination);
                return Err("cannot create IOSurface send right".into());
            }
            let mut message = Self {
                header: mach_msg_header_t {
                    msgh_bits: MACH_MSG_TYPE_COPY_SEND | MACH_MSGH_BITS_COMPLEX,
                    msgh_size: size_of::<Self>() as u32,
                    msgh_remote_port: destination,
                    msgh_id: 0x41535452,
                    ..Default::default()
                },
                body: mach_msg_body_t {
                    msgh_descriptor_count: 1,
                },
                surface: mach_msg_port_descriptor_t::new(port, MACH_MSG_TYPE_COPY_SEND),
                sequence,
            };
            let status = mach_msg(
                &mut message.header,
                MACH_SEND_MSG | MACH_SEND_TIMEOUT,
                size_of::<Self>() as u32,
                0,
                MACH_PORT_NULL,
                1000,
                MACH_PORT_NULL,
            );
            mach_port_deallocate(mach_task_self(), port);
            mach_port_deallocate(mach_task_self(), destination);
            if status != 0 {
                return Err(format!("Mach surface transfer failed: {status}"));
            }
        }
        Ok(())
    }
}

#[cfg(feature = "node-addon")]
pub(crate) struct Receiver {
    port: mach_port_t,
    leases: BTreeMap<u64, CFRetained<IOSurfaceRef>>,
}

#[cfg(feature = "node-addon")]
impl Receiver {
    pub(crate) fn open(service: &str) -> Result<Self, String> {
        let service = SurfaceMessage::service_name(service)?;
        let mut receiver = Self {
            port: MACH_PORT_NULL,
            leases: BTreeMap::new(),
        };
        unsafe {
            let mut status = mach_port_allocate(
                mach_task_self(),
                MACH_PORT_RIGHT_RECEIVE,
                &mut receiver.port,
            );
            if status == 0 {
                status = mach_port_insert_right(
                    mach_task_self(),
                    receiver.port,
                    receiver.port,
                    MACH_MSG_TYPE_MAKE_SEND,
                );
            }
            if status == 0 {
                status =
                    bootstrap_register(bootstrap_port, service.as_ptr().cast_mut(), receiver.port);
            }
            if status != 0 {
                return Err(format!("cannot register private Mach receiver: {status}"));
            }
        }
        Ok(receiver)
    }

    pub(crate) fn receive(
        &mut self,
        pid: u64,
        sequence: u64,
        width: u64,
        height: u64,
    ) -> Result<Vec<u8>, String> {
        if self.port == MACH_PORT_NULL
            || self.leases.len() >= 3
            || self.leases.contains_key(&sequence)
        {
            return Err("surface receiver is closed or full".into());
        }
        #[repr(C)]
        #[derive(Default)]
        struct Received {
            message: SurfaceMessage,
            trailer: mach_msg_audit_trailer_t,
        }
        let mut received = Received::default();
        let message = &mut received.message;
        unsafe {
            // MACH_RCV_TRAILER_ELEMENTS(AUDIT) requests kernel-authenticated sender identity.
            let status = mach_msg(
                &mut message.header,
                MACH_RCV_MSG | MACH_RCV_TIMEOUT | ((MACH_RCV_TRAILER_AUDIT as i32) << 24),
                0,
                size_of::<Received>() as u32,
                self.port,
                1000,
                MACH_PORT_NULL,
            );
            if status != 0 {
                return Err(format!("Mach surface receive failed: {status}"));
            }
            // Validate the fixed message length before inspecting the trailer at that offset.
            let valid = message.header.msgh_size as usize == size_of::<SurfaceMessage>()
                && message.header.msgh_bits & MACH_MSGH_BITS_COMPLEX != 0
                && message.header.msgh_id == 0x41535452
                && message.body.msgh_descriptor_count == 1
                && message.surface.type_ == MACH_MSG_PORT_DESCRIPTOR as u8
                && message.surface.disposition == MACH_MSG_TYPE_PORT_SEND as u8
                && message.sequence == sequence
                && received.trailer.msgh_trailer_type == MACH_MSG_TRAILER_FORMAT_0
                && received.trailer.msgh_trailer_size as usize
                    >= size_of::<mach_msg_audit_trailer_t>()
                && u64::from(received.trailer.msgh_audit.val[5]) == pid;
            let surface = if valid {
                IOSurfaceRef::lookup_from_mach_port(message.surface.name)
            } else {
                None
            };
            mach_msg_destroy(&mut message.header);
            let surface = surface.ok_or("Mach surface sender, sequence or right differs")?;
            if surface.width() as u64 != width
                || surface.height() as u64 != height
                || surface.pixel_format() != u32::from_be_bytes(*b"BGRA")
            {
                return Err("transferred IOSurface format differs".into());
            }
            let pointer = CFRetained::as_ptr(&surface).as_ptr() as usize;
            self.leases.insert(sequence, surface);
            Ok(pointer.to_ne_bytes().to_vec())
        }
    }

    pub(crate) fn release(&mut self, sequence: u64) {
        // Dropping the retained reference ends this process's lease only.
        self.leases.remove(&sequence);
    }

    pub(crate) fn close(&mut self) {
        self.leases.clear();
        if self.port != MACH_PORT_NULL {
            unsafe {
                mach_port_destroy(mach_task_self(), self.port);
            }
            self.port = MACH_PORT_NULL;
        }
    }
}

#[cfg(feature = "node-addon")]
impl Drop for Receiver {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(all(test, feature = "node-addon"))]
mod tests {
    use super::Receiver;
    use crate::Surface;

    #[test]
    fn validates_sender_and_bounds_surface_leases() -> Result<(), String> {
        let pid = u64::from(std::process::id());
        let service = format!("io.aster.preview.rust-test-{pid}");
        let mut receiver = Receiver::open(&service)?;
        let surface = Surface::new(32, 18)?;
        surface.send(&service, 1)?;
        assert!(receiver.receive(pid + 1, 1, 32, 18).is_err());
        surface.send(&service, 2)?;
        assert!(receiver.receive(pid, 2, 33, 18).is_err());
        for sequence in 3..6 {
            surface.send(&service, sequence)?;
            assert_eq!(
                receiver.receive(pid, sequence, 32, 18)?.len(),
                size_of::<usize>()
            );
        }
        assert!(receiver.receive(pid, 6, 32, 18).is_err());
        receiver.release(3);
        surface.send(&service, 6)?;
        assert!(receiver.receive(pid, 6, 32, 18).is_ok());
        receiver.close();
        assert!(receiver.receive(pid, 7, 32, 18).is_err());
        assert!(surface.send("not-a-private-service", 1).is_err());
        Ok(())
    }
}
