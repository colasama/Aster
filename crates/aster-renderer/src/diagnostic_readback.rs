use std::sync::mpsc;

use super::{NativeRenderer, RenderedFrame};
use crate::RenderError;

impl NativeRenderer {
    /// Explicit lossless-output or diagnostic readback. Preview and encoders consume the texture directly.
    pub fn read_rgba(&self, frame: &RenderedFrame) -> Result<Vec<u8>, RenderError> {
        self.read_texture_rgba(&frame.texture, frame.size, true)
    }

    /// Read an already admitted glyph generation, independently of scene padding or compositing.
    /// This diagnostic never renders a recipe or substitutes a CPU layer raster.
    pub fn read_native_glyph_rgba(
        &self,
        input: &crate::NativeGlyphInput,
    ) -> Result<Vec<u8>, RenderError> {
        let texture = self.glyphs.diagnostic_output(input)?;
        self.read_texture_rgba(texture, input.plan.size, false)
    }

    /// Materialize an existing GPU generation for an explicitly requested diagnostic bundle.
    pub fn capture_native_glyph(
        &self,
        input: &crate::NativeGlyphInput,
        byte_budget: u64,
    ) -> Result<aster_render_ir::VerifiedResource, RenderError> {
        use aster_render_ir::{
            MediaTextureFormat, RasterPixelsDescriptor, ResourceDescriptor, ResourceKind,
            VerifiedResource,
        };
        if input.output_bytes > byte_budget {
            return Err(RenderError::Invalid(
                "glyph capture byte budget exceeded".into(),
            ));
        }
        Ok(VerifiedResource::new(
            ResourceKind::RasterPixels,
            ResourceDescriptor::RasterPixels(RasterPixelsDescriptor {
                frame: input.frame.clone(),
                width: input.plan.size.width,
                height: input.plan.size.height,
                format: MediaTextureFormat::Rgba8UnormSrgb,
            }),
            self.read_native_glyph_rgba(input)?,
        )?)
    }

    fn read_texture_rgba(
        &self,
        texture: &wgpu::Texture,
        size: aster_render_ir::Extent2d,
        bgra: bool,
    ) -> Result<Vec<u8>, RenderError> {
        let row = size.width * 4;
        let padded = row.div_ceil(256) * 256;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Diagnostic RGBA readback"),
            size: u64::from(padded) * u64::from(size.height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(size.height),
                },
            },
            wgpu::Extent3d {
                width: size.width,
                height: size.height,
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
        let mut pixels = Vec::with_capacity(row as usize * size.height as usize);
        {
            let mapped = buffer
                .slice(..)
                .get_mapped_range()
                .map_err(|error| RenderError::Gpu(error.to_string()))?;
            for bytes in mapped.chunks_exact(padded as usize) {
                for pixel in bytes[..row as usize].chunks_exact(4) {
                    if bgra {
                        pixels.extend([pixel[2], pixel[1], pixel[0], pixel[3]]);
                    } else {
                        pixels.extend_from_slice(pixel);
                    }
                }
            }
        }
        buffer.unmap();
        Ok(pixels)
    }
}
