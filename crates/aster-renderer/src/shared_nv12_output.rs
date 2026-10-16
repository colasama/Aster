use super::{Arc, NativeRenderer, RenderError, RenderedFrame};
use crate::shared_nv12::{SharedNv12Frame, SharedNv12Target};
use aster_render_ir::Extent2d;

impl NativeRenderer {
    /// Allocate a bounded pool before the first frame; every outstanding lease prevents reuse.
    pub fn prepare_shared_nv12(&mut self, size: Extent2d, slots: u32) -> Result<(), RenderError> {
        if !(1..=33).contains(&slots) {
            return Err(RenderError::Invalid("shared NV12 slot limit".into()));
        }
        self.prepare_nv12(size)?;
        if !self.shared_nv12.is_empty() {
            return if self.shared_nv12.len() == slots as usize {
                Ok(())
            } else {
                Err(RenderError::Invalid(
                    "shared NV12 pool cannot change".into(),
                ))
            };
        }
        if self.targets.is_some() {
            return Err(RenderError::Invalid(
                "prepare shared NV12 before rendering".into(),
            ));
        }
        let allocation = SharedNv12Target::allocation_bytes(&self.device, size)?;
        let remaining = allocation
            .checked_mul(u64::from(slots))
            .and_then(|bytes| self.options.gpu_budget_bytes.checked_sub(bytes))
            .filter(|remaining| *remaining > 0)
            .ok_or_else(|| RenderError::Invalid("shared NV12 pool exceeds GPU budget".into()))?;
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let targets = (0..slots)
            .map(|_| SharedNv12Target::new(&self.device, size).map(Arc::new))
            .collect::<Result<Vec<_>, _>>();
        let errors = [
            pollster::block_on(validation.pop()),
            pollster::block_on(internal.pop()),
            pollster::block_on(memory.pop()),
        ];
        if let Some(error) = errors.into_iter().flatten().next() {
            return Err(RenderError::Gpu(error.to_string()));
        }
        self.shared_nv12 = targets?;
        self.shared_nv12_reserved_bytes = self.options.gpu_budget_bytes - remaining;
        self.options.gpu_budget_bytes = remaining;
        Ok(())
    }

    /// Return an unused sharing reservation when capability selection chooses readback.
    pub fn release_shared_nv12(&mut self) -> Result<(), RenderError> {
        if self
            .shared_nv12
            .iter()
            .any(|target| Arc::strong_count(target) != 1)
        {
            return Err(RenderError::Invalid(
                "cannot release a leased NV12 pool".into(),
            ));
        }
        self.device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(self.options.timeout),
            })
            .map_err(|error| RenderError::Gpu(error.to_string()))?;
        self.shared_nv12.clear();
        self.options.gpu_budget_bytes += self.shared_nv12_reserved_bytes;
        self.shared_nv12_reserved_bytes = 0;
        Ok(())
    }

    /// Converts and copies on the GPU, returning only after D3D12 has released the shared planes.
    pub fn share_nv12(&mut self, frame: &RenderedFrame) -> Result<SharedNv12Frame, RenderError> {
        self.share_nv12_texture(&frame.texture)
    }

    pub(super) fn share_nv12_texture(
        &mut self,
        texture: &wgpu::Texture,
    ) -> Result<SharedNv12Frame, RenderError> {
        let index = self
            .shared_nv12
            .iter()
            .position(|target| Arc::strong_count(target) == 1)
            .ok_or_else(|| RenderError::Invalid("shared NV12 pool has no released slot".into()))?;
        let target = Arc::clone(&self.shared_nv12[index]);
        let converter = self
            .nv12
            .as_ref()
            .ok_or_else(|| RenderError::Invalid("NV12 output is not prepared".into()))?;
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let result = converter.copy_shared(
            &self.device,
            &self.queue,
            texture,
            &target,
            self.options.timeout,
            self.gpu_profiler.as_ref(),
        );
        let errors = [
            pollster::block_on(validation.pop()),
            pollster::block_on(internal.pop()),
            pollster::block_on(memory.pop()),
        ];
        if let Some(error) = errors.into_iter().flatten().next() {
            self.shared_nv12.remove(index);
            return Err(RenderError::Gpu(error.to_string()));
        }
        if let Err(error) = result {
            // An incomplete submission must never return its slot to the pool.
            self.shared_nv12.remove(index);
            return Err(error);
        }
        if let Some(profile) = &self.gpu_profiler {
            let times = profile.read(&self.device, self.options.timeout, 3)?;
            let timing = self.gpu_timings.get_or_insert_with(Default::default);
            timing.nv12_conversion_ms = times[0];
            timing.nv12_copy_ms = times[1];
        }
        Ok(SharedNv12Frame { target })
    }
}
