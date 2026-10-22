use super::{Arc, NativeRenderer, RenderError, RenderedFrame};
use crate::shared_preview::{SharedPreviewFrame, SharedPreviewTarget};
use aster_render_ir::Extent2d;

impl NativeRenderer {
    /// Reserve a fixed-size bounded pool before rendering; resize uses a new owned generation.
    pub fn prepare_shared_preview(
        &mut self,
        size: Extent2d,
        slots: u32,
    ) -> Result<(), RenderError> {
        if !(1..=3).contains(&slots) {
            return Err(RenderError::Invalid(
                "shared preview requires one to three slots".into(),
            ));
        }
        if !self.shared_preview.is_empty() {
            return if self.shared_preview.len() == slots as usize
                && self.shared_preview.iter().all(|target| target.size == size)
            {
                Ok(())
            } else {
                Err(RenderError::Invalid(
                    "shared preview pool generation cannot change".into(),
                ))
            };
        }
        if self.shared_preview_reserved_bytes != 0 {
            return Err(RenderError::Invalid(
                "release failed preview generation before preparing another".into(),
            ));
        }
        if self.targets.is_some() {
            return Err(RenderError::Invalid(
                "prepare shared preview before rendering".into(),
            ));
        }
        let allocation = SharedPreviewTarget::allocation_bytes(&self.device, size)?;
        let remaining = allocation
            .checked_mul(u64::from(slots))
            .and_then(|bytes| self.options.gpu_budget_bytes.checked_sub(bytes))
            .filter(|remaining| *remaining > 0)
            .ok_or_else(|| RenderError::Invalid("shared preview exceeds GPU budget".into()))?;
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let targets = (0..slots)
            .map(|_| SharedPreviewTarget::new(&self.device, size).map(Arc::new))
            .collect::<Result<Vec<_>, _>>();
        let errors = [
            pollster::block_on(validation.pop()),
            pollster::block_on(internal.pop()),
            pollster::block_on(memory.pop()),
        ];
        if let Some(error) = errors.into_iter().flatten().next() {
            return Err(RenderError::Gpu(error.to_string()));
        }
        self.shared_preview = targets?;
        self.shared_preview_reserved_bytes = self.options.gpu_budget_bytes - remaining;
        self.options.gpu_budget_bytes = remaining;
        Ok(())
    }

    /// Release an unused sharing reservation, including after an unavailable consumer probe.
    pub fn release_shared_preview(&mut self) -> Result<(), RenderError> {
        if self
            .shared_preview
            .iter()
            .any(|target| Arc::strong_count(target) != 1)
        {
            return Err(RenderError::Invalid(
                "cannot release leased preview surfaces".into(),
            ));
        }
        self.device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(self.options.timeout),
            })
            .map_err(|error| RenderError::Gpu(error.to_string()))?;
        self.shared_preview.clear();
        self.options.gpu_budget_bytes += self.shared_preview_reserved_bytes;
        self.shared_preview_reserved_bytes = 0;
        Ok(())
    }

    /// Copy completed native display pixels on the GPU without a CPU pixel mapping.
    pub fn share_preview(
        &mut self,
        frame: &RenderedFrame,
    ) -> Result<SharedPreviewFrame, RenderError> {
        if !self
            .output_lease
            .upgrade()
            .is_some_and(|lease| Arc::ptr_eq(&lease, &frame._lease))
        {
            return Err(RenderError::Invalid(
                "preview frame belongs to another renderer generation".into(),
            ));
        }
        self.share_preview_texture(&frame.texture)
    }

    pub(super) fn share_preview_texture(
        &mut self,
        texture: &wgpu::Texture,
    ) -> Result<SharedPreviewFrame, RenderError> {
        let index = self
            .shared_preview
            .iter()
            .position(|target| Arc::strong_count(target) == 1)
            .ok_or_else(|| {
                RenderError::Invalid("shared preview pool has no released slot".into())
            })?;
        let target = Arc::clone(&self.shared_preview[index]);
        if texture.format() != wgpu::TextureFormat::Bgra8Unorm
            || texture.size() != target.texture.size()
            || !texture.usage().contains(wgpu::TextureUsages::COPY_SRC)
        {
            return Err(RenderError::Invalid(
                "preview source format or extent differs".into(),
            ));
        }
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Share native preview"),
            });
        encoder.copy_texture_to_texture(
            texture.as_image_copy(),
            target.texture.as_image_copy(),
            texture.size(),
        );
        let submission = self.queue.submit([encoder.finish()]);
        // Simultaneous-access resources decay to COMMON on completion. Publish only after
        // this transition; the consumer owns the immutable lease until its GPU work ends.
        let completed = self.device.poll(wgpu::PollType::Wait {
            submission_index: Some(submission),
            timeout: Some(self.options.timeout),
        });
        let errors = [
            pollster::block_on(validation.pop()),
            pollster::block_on(internal.pop()),
            pollster::block_on(memory.pop()),
        ];
        if let Some(error) = errors.into_iter().flatten().next() {
            self.shared_preview.remove(index);
            return Err(RenderError::Gpu(error.to_string()));
        }
        if let Err(error) = completed {
            self.shared_preview.remove(index);
            return Err(RenderError::Gpu(error.to_string()));
        }
        Ok(SharedPreviewFrame { target })
    }
}
