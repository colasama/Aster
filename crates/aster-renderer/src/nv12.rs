use std::{sync::mpsc, time::Duration};

use aster_render_ir::{DecodeLimits, Extent2d};
use aster_shaders::ShaderCatalog;

use crate::RenderError;

/// One reusable conversion slot: only packed NV12 crosses the native GPU/CPU boundary.
pub(crate) struct Nv12Converter {
    pub(crate) size: Extent2d,
    bytes: u64,
    row_bytes: u32,
    padded_bytes: u64,
    pipeline: wgpu::ComputePipeline,
    packed: wgpu::Buffer,
    staging: wgpu::Buffer,
}

impl Nv12Converter {
    pub(crate) fn required_bytes(size: Extent2d) -> Result<u64, RenderError> {
        size.validate(&DecodeLimits::default())?;
        if !size.width.is_multiple_of(2) || !size.height.is_multiple_of(2) {
            return Err(RenderError::Invalid("NV12 requires even dimensions".into()));
        }
        Ok(u64::from(size.width.div_ceil(256) * 256) * u64::from(size.height) * 3)
    }

    pub(crate) fn new(device: &wgpu::Device, size: Extent2d) -> Result<Self, RenderError> {
        let padded_bytes = Self::required_bytes(size)? / 2;
        if padded_bytes > device.limits().max_storage_buffer_binding_size
            || padded_bytes > device.limits().max_buffer_size
            || (u64::from(size.width.div_ceil(256) * 256) * u64::from(size.height) / 4).div_ceil(64)
                > u64::from(device.limits().max_compute_workgroups_per_dimension)
        {
            return Err(RenderError::Invalid(
                "NV12 conversion exceeds device limits".into(),
            ));
        }
        let catalog = ShaderCatalog::embedded()?;
        let source = &catalog.program("output-nv12")?.source;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("BT.709 limited NV12 conversion"),
            source: wgpu::ShaderSource::Wgsl(source.as_str().into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Packed NV12 conversion"),
            layout: None,
            module: &module,
            entry_point: Some("convert"),
            compilation_options: Default::default(),
            cache: None,
        });
        let packed = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("GPU packed NV12"),
            size: padded_bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Native NV12 readback"),
            size: padded_bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        Ok(Self {
            size,
            bytes: u64::from(size.width) * u64::from(size.height) * 3 / 2,
            row_bytes: size.width.div_ceil(256) * 256,
            padded_bytes,
            pipeline,
            packed,
            staging,
        })
    }

    fn encode(
        &self,
        device: &wgpu::Device,
        texture: &wgpu::Texture,
        profile: Option<&crate::gpu_profile::GpuProfiler>,
    ) -> Result<wgpu::CommandEncoder, RenderError> {
        if texture.width() != self.size.width
            || texture.height() != self.size.height
            || texture.format() != wgpu::TextureFormat::Bgra8Unorm
            || texture.sample_count() != 1
        {
            return Err(RenderError::Invalid(
                "NV12 source must match the prepared BGRA output".into(),
            ));
        }
        let view = texture.create_view(&Default::default());
        let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("NV12 input/output"),
            layout: &self.pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: self.packed.as_entire_binding(),
                },
            ],
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        if let Some(profile) = profile {
            profile.mark(&mut encoder, 0);
        }
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bindings, &[]);
            pass.dispatch_workgroups((self.row_bytes * self.size.height / 4).div_ceil(64), 1, 1);
        }
        if let Some(profile) = profile {
            profile.mark(&mut encoder, 1);
        }
        Ok(encoder)
    }

    #[cfg(windows)]
    pub(crate) fn copy_shared(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        source: &wgpu::Texture,
        target: &crate::shared_nv12::SharedNv12Target,
        timeout: Duration,
        profile: Option<&crate::gpu_profile::GpuProfiler>,
    ) -> Result<(), RenderError> {
        if target.size != self.size {
            return Err(RenderError::Invalid(
                "shared NV12 dimensions changed".into(),
            ));
        }
        let mut encoder = self.encode(device, source, profile)?;
        for (plane, texture) in target.planes.iter().enumerate() {
            encoder.copy_buffer_to_texture(
                wgpu::TexelCopyBufferInfo {
                    buffer: &self.packed,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: if plane == 0 {
                            0
                        } else {
                            u64::from(self.row_bytes) * u64::from(self.size.height)
                        },
                        bytes_per_row: Some(self.row_bytes),
                        rows_per_image: None,
                    },
                },
                texture.as_image_copy(),
                texture.size(),
            );
        }
        if let Some(profile) = profile {
            profile.mark(&mut encoder, 2);
            profile.resolve(&mut encoder, 3);
        }
        let submission = queue.submit([encoder.finish()]);
        // Completion establishes ownership transfer to D3D11. Simultaneous-access
        // resources decay to COMMON after the submission; no pixel data is mapped.
        device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(submission),
                timeout: Some(timeout),
            })
            .map_err(|error| RenderError::Gpu(error.to_string()))?;
        Ok(())
    }

    pub(crate) fn read(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        texture: &wgpu::Texture,
        timeout: Duration,
        profile: Option<&crate::gpu_profile::GpuProfiler>,
    ) -> Result<Vec<u8>, RenderError> {
        let mut encoder = self.encode(device, texture, profile)?;
        encoder.copy_buffer_to_buffer(&self.packed, 0, &self.staging, 0, self.padded_bytes);
        if let Some(profile) = profile {
            profile.mark(&mut encoder, 2);
            profile.resolve(&mut encoder, 3);
        }
        let submission = queue.submit([encoder.finish()]);
        let (sender, receiver) = mpsc::sync_channel(1);
        self.staging
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });
        let copied = (|| {
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: Some(submission),
                    timeout: Some(timeout),
                })
                .map_err(|error| RenderError::Gpu(error.to_string()))?;
            receiver
                .recv_timeout(timeout)
                .map_err(|error| RenderError::Gpu(error.to_string()))?
                .map_err(|error| RenderError::Gpu(error.to_string()))?;
            let mapped = self
                .staging
                .slice(..)
                .get_mapped_range()
                .map_err(|error| RenderError::Gpu(error.to_string()))?;
            let mut bytes = Vec::with_capacity(self.bytes as usize);
            for row in mapped.chunks_exact(self.row_bytes as usize) {
                bytes.extend_from_slice(&row[..self.size.width as usize]);
            }
            Ok(bytes)
        })();
        self.staging.unmap();
        copied
    }
}
