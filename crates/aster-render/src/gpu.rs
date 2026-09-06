use serde::{Deserialize, Serialize};
use std::time::Duration;
use thiserror::Error;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AdapterDiagnostics {
    pub name: String,
    pub vendor: u32,
    pub device: u32,
    pub device_type: String,
    pub driver: String,
    pub driver_info: String,
    pub backend: String,
}

impl AdapterDiagnostics {
    pub fn from_adapter(adapter: &wgpu::Adapter) -> Self {
        let info = adapter.get_info();
        Self {
            name: info.name,
            vendor: info.vendor,
            device: info.device,
            device_type: format!("{:?}", info.device_type),
            driver: info.driver,
            driver_info: info.driver_info,
            backend: format!("{:?}", info.backend),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NativeBackend {
    Vulkan,
    Metal,
    Dx12,
}

impl NativeBackend {
    pub(crate) const fn backends(self) -> wgpu::Backends {
        match self {
            Self::Vulkan => wgpu::Backends::VULKAN,
            Self::Metal => wgpu::Backends::METAL,
            Self::Dx12 => wgpu::Backends::DX12,
        }
    }

    pub(crate) const fn adapter_backend(self) -> wgpu::Backend {
        match self {
            Self::Vulkan => wgpu::Backend::Vulkan,
            Self::Metal => wgpu::Backend::Metal,
            Self::Dx12 => wgpu::Backend::Dx12,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BackendSmokeReport {
    pub backend: NativeBackend,
    pub adapter: AdapterDiagnostics,
    pub command_submission_completed: bool,
}

#[derive(Debug, Error)]
pub enum BackendSmokeError {
    #[error("the {0:?} backend is not compiled into this wgpu build")]
    BackendNotCompiled(NativeBackend),
    #[error("the {0:?} backend exposed no adapter")]
    AdapterUnavailable(NativeBackend),
    #[error("requesting a device failed: {0}")]
    Device(String),
    #[error("the backend smoke command failed: {0}")]
    Command(String),
}

impl NativeBackend {
    /// Exercises adapter discovery, device creation, queue submission, and bounded
    /// completion on one native backend without requiring a window or surface.
    pub fn smoke_test(self, timeout: Duration) -> Result<BackendSmokeReport, BackendSmokeError> {
        let backend = self;
        if !wgpu::Instance::enabled_backend_features().contains(backend.backends()) {
            return Err(BackendSmokeError::BackendNotCompiled(backend));
        }
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: backend.backends(),
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let adapters = pollster::block_on(instance.enumerate_adapters(backend.backends()));
        let adapter = adapters
            .into_iter()
            .filter(|candidate| candidate.get_info().backend == backend.adapter_backend())
            .max_by_key(|candidate| Self::adapter_priority(candidate.get_info().device_type))
            .ok_or(BackendSmokeError::AdapterUnavailable(backend))?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("Aster native backend smoke device"),
            ..Default::default()
        }))
        .map_err(|error| BackendSmokeError::Device(error.to_string()))?;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Aster native backend smoke buffer"),
            size: 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Aster native backend smoke encoder"),
        });
        encoder.clear_buffer(&buffer, 0, None);
        let submission = queue.submit([encoder.finish()]);
        device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(submission),
                timeout: Some(timeout),
            })
            .map_err(|error| BackendSmokeError::Command(format!("{error:?}")))?;
        Ok(BackendSmokeReport {
            backend,
            adapter: AdapterDiagnostics::from_adapter(&adapter),
            command_submission_completed: true,
        })
    }

    pub(crate) const fn adapter_priority(device_type: wgpu::DeviceType) -> u8 {
        match device_type {
            wgpu::DeviceType::DiscreteGpu => 4,
            wgpu::DeviceType::IntegratedGpu => 3,
            wgpu::DeviceType::VirtualGpu => 2,
            wgpu::DeviceType::Cpu => 1,
            wgpu::DeviceType::Other => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_names_have_stable_json_values() -> Result<(), Box<dyn std::error::Error>> {
        assert_eq!(serde_json::to_string(&NativeBackend::Vulkan)?, "\"vulkan\"");
        assert_eq!(serde_json::to_string(&NativeBackend::Metal)?, "\"metal\"");
        assert_eq!(serde_json::to_string(&NativeBackend::Dx12)?, "\"dx12\"");
        assert!(!NativeBackend::Dx12.backends().contains(wgpu::Backends::GL));
        Ok(())
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires a native DX12 adapter"]
    fn windows_dx12_command_submission() -> Result<(), Box<dyn std::error::Error>> {
        NativeBackend::Dx12.smoke_test(Duration::from_secs(30))?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires a native Vulkan adapter"]
    fn windows_vulkan_command_submission() -> Result<(), Box<dyn std::error::Error>> {
        NativeBackend::Vulkan.smoke_test(Duration::from_secs(30))?;
        Ok(())
    }
}
