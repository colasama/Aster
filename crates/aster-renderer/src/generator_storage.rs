use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

/// Writable instances are generation-local even when their allocation is recycled.
#[derive(Clone)]
pub(crate) struct GeneratorStorage {
    pub buffer: wgpu::Buffer,
    clear_pending: Arc<AtomicBool>,
}

impl GeneratorStorage {
    pub fn new(device: &wgpu::Device, bytes: u64, recycled: Option<wgpu::Buffer>) -> Self {
        let clear_pending = Arc::new(AtomicBool::new(recycled.is_some()));
        let buffer = match recycled {
            Some(buffer) => buffer,
            None => device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Time-addressed generator instances"),
                size: bytes,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_DST
                    | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            }),
        };
        Self {
            buffer,
            clear_pending,
        }
    }

    pub fn initialize(&self, encoder: &mut wgpu::CommandEncoder, fully_overwritten: bool) {
        // Cloned bindings share this flag: auxiliary passes in the same frame must not reset it.
        if self.clear_pending.swap(false, Ordering::Relaxed) && !fully_overwritten {
            encoder.clear_buffer(&self.buffer, 0, None);
        }
    }
}

#[derive(Default)]
pub(crate) struct GeneratorStoragePool {
    buffers: BTreeMap<u64, Vec<wgpu::Buffer>>,
    pub bytes: u64,
}

impl GeneratorStoragePool {
    /// Called only after previous GPU submissions have completed.
    pub fn recycle(&mut self, buffers: impl Iterator<Item = wgpu::Buffer>, budget: u64) {
        self.buffers.clear();
        self.bytes = 0;
        for buffer in buffers {
            let size = buffer.size();
            if size <= budget.saturating_sub(self.bytes) {
                self.buffers.entry(size).or_default().push(buffer);
                self.bytes += size;
            }
        }
    }

    /// Reserve the next invocation first; unused old allocations cannot exceed its remaining budget.
    pub fn take(&mut self, bytes: u64, remaining_budget: u64) -> Option<wgpu::Buffer> {
        let buffer = self.buffers.get_mut(&bytes).and_then(Vec::pop);
        if buffer.is_some() {
            self.bytes -= bytes;
        }
        if self.buffers.get(&bytes).is_some_and(Vec::is_empty) {
            self.buffers.remove(&bytes);
        }
        while self.bytes > remaining_budget {
            let Some((size, buffers)) = self.buffers.pop_last() else {
                break;
            };
            self.bytes -= size * buffers.len() as u64;
        }
        buffer
    }
}
