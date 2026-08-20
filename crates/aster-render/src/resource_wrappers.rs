#[derive(Clone, Debug)]
pub struct TextureResourceDescriptor {
    pub label: String,
    pub size: wgpu::Extent3d,
    pub mip_level_count: u32,
    pub sample_count: u32,
    pub dimension: wgpu::TextureDimension,
    pub format: wgpu::TextureFormat,
    pub usage: wgpu::TextureUsages,
    pub view_formats: Vec<wgpu::TextureFormat>,
}

impl TextureResourceDescriptor {
    pub fn texture_2d(
        label: impl Into<String>,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
        usage: wgpu::TextureUsages,
    ) -> Self {
        Self {
            label: label.into(),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: Vec::new(),
        }
    }

    #[must_use]
    pub fn estimated_bytes(&self) -> u64 {
        let (block_width, block_height) = self.format.block_dimensions();
        let block_bytes = u64::from(self.format.block_copy_size(None).unwrap_or(4));
        let mut width = self.size.width;
        let mut height = self.size.height;
        let mut depth = self.size.depth_or_array_layers;
        let mut total = 0_u64;

        for _ in 0..self.mip_level_count {
            let blocks_wide = u64::from(width.div_ceil(block_width));
            let blocks_high = u64::from(height.div_ceil(block_height));
            total = total.saturating_add(
                blocks_wide
                    .saturating_mul(blocks_high)
                    .saturating_mul(u64::from(depth))
                    .saturating_mul(block_bytes)
                    .saturating_mul(u64::from(self.sample_count)),
            );
            width = (width / 2).max(1);
            height = (height / 2).max(1);
            if self.dimension == wgpu::TextureDimension::D3 {
                depth = (depth / 2).max(1);
            }
        }
        total
    }
}

pub struct TextureResource {
    raw: wgpu::Texture,
    descriptor: TextureResourceDescriptor,
}

impl TextureResource {
    #[must_use]
    pub fn create(device: &wgpu::Device, descriptor: TextureResourceDescriptor) -> Self {
        let raw = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(&descriptor.label),
            size: descriptor.size,
            mip_level_count: descriptor.mip_level_count,
            sample_count: descriptor.sample_count,
            dimension: descriptor.dimension,
            format: descriptor.format,
            usage: descriptor.usage,
            view_formats: &descriptor.view_formats,
        });
        Self { raw, descriptor }
    }

    #[must_use]
    pub fn raw(&self) -> &wgpu::Texture {
        &self.raw
    }

    #[must_use]
    pub fn descriptor(&self) -> &TextureResourceDescriptor {
        &self.descriptor
    }

    #[must_use]
    pub fn estimated_bytes(&self) -> u64 {
        self.descriptor.estimated_bytes()
    }

    #[must_use]
    pub fn create_view(&self, descriptor: &wgpu::TextureViewDescriptor<'_>) -> wgpu::TextureView {
        self.raw.create_view(descriptor)
    }
}

#[derive(Clone, Debug)]
pub struct BufferResourceDescriptor {
    pub label: String,
    pub size: wgpu::BufferAddress,
    pub usage: wgpu::BufferUsages,
    pub mapped_at_creation: bool,
}

impl BufferResourceDescriptor {
    pub fn new(
        label: impl Into<String>,
        size: wgpu::BufferAddress,
        usage: wgpu::BufferUsages,
    ) -> Self {
        Self {
            label: label.into(),
            size,
            usage,
            mapped_at_creation: false,
        }
    }
}

pub struct BufferResource {
    raw: wgpu::Buffer,
    descriptor: BufferResourceDescriptor,
}

impl BufferResource {
    #[must_use]
    pub fn create(device: &wgpu::Device, descriptor: BufferResourceDescriptor) -> Self {
        let raw = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&descriptor.label),
            size: descriptor.size,
            usage: descriptor.usage,
            mapped_at_creation: descriptor.mapped_at_creation,
        });
        Self { raw, descriptor }
    }

    #[must_use]
    pub fn raw(&self) -> &wgpu::Buffer {
        &self.raw
    }

    #[must_use]
    pub fn descriptor(&self) -> &BufferResourceDescriptor {
        &self.descriptor
    }

    #[must_use]
    pub fn estimated_bytes(&self) -> u64 {
        self.descriptor.size
    }

    pub fn write(&self, queue: &wgpu::Queue, offset: wgpu::BufferAddress, data: &[u8]) {
        assert!(
            offset.saturating_add(data.len() as u64) <= self.descriptor.size,
            "buffer write exceeds resource capacity"
        );
        queue.write_buffer(&self.raw, offset, data);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimates_uncompressed_mip_chain() {
        let mut descriptor = TextureResourceDescriptor::texture_2d(
            "mipped",
            4,
            4,
            wgpu::TextureFormat::Rgba8Unorm,
            wgpu::TextureUsages::TEXTURE_BINDING,
        );
        descriptor.mip_level_count = 3;
        assert_eq!(descriptor.estimated_bytes(), 84);
    }

    #[test]
    fn estimates_compressed_blocks_and_array_layers() {
        let mut descriptor = TextureResourceDescriptor::texture_2d(
            "compressed",
            7,
            5,
            wgpu::TextureFormat::Bc1RgbaUnorm,
            wgpu::TextureUsages::TEXTURE_BINDING,
        );
        descriptor.size.depth_or_array_layers = 3;
        assert_eq!(descriptor.estimated_bytes(), 96);
    }

    #[test]
    fn buffer_metadata_preserves_allocation_size() {
        let descriptor = BufferResourceDescriptor::new(
            "uniforms",
            4_096,
            wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        );
        assert_eq!(descriptor.size, 4_096);
        assert!(!descriptor.mapped_at_creation);
    }
}
