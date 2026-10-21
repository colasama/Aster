use std::sync::mpsc;

use super::{NativeRenderer, RenderedFrame};
use crate::RenderError;

impl NativeRenderer {
    /// Explicit diagnostic readback. Preview and encoder integrations consume the texture directly.
    pub fn read_rgba(&self, frame: &RenderedFrame) -> Result<Vec<u8>, RenderError> {
        let row = frame.size.width * 4;
        let padded = row.div_ceil(256) * 256;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Diagnostic RGBA readback"),
            size: u64::from(padded) * u64::from(frame.size.height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            frame.texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(frame.size.height),
                },
            },
            wgpu::Extent3d {
                width: frame.size.width,
                height: frame.size.height,
                depth_or_array_layers: 1,
            },
        );
        let submission = self.queue.submit([encoder.finish()]);
        let (sender, receiver) = mpsc::sync_channel(1);
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });
        self.device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(submission),
                timeout: Some(self.options.timeout),
            })
            .map_err(|error| RenderError::Gpu(error.to_string()))?;
        receiver
            .recv_timeout(self.options.timeout)
            .map_err(|error| RenderError::Gpu(error.to_string()))?
            .map_err(|error| RenderError::Gpu(error.to_string()))?;
        let mut pixels = Vec::with_capacity(row as usize * frame.size.height as usize);
        {
            let mapped = buffer
                .slice(..)
                .get_mapped_range()
                .map_err(|error| RenderError::Gpu(error.to_string()))?;
            for bytes in mapped.chunks_exact(padded as usize) {
                for bgra in bytes[..row as usize].chunks_exact(4) {
                    pixels.extend([bgra[2], bgra[1], bgra[0], bgra[3]]);
                }
            }
        }
        buffer.unmap();
        Ok(pixels)
    }
}
