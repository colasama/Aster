use wgpu::util::DeviceExt;

use crate::{RenderError, generator_input::GeneratorInput};

pub(crate) struct GeneratorBindings {
    pub compute: wgpu::BindGroup,
    pub render: wgpu::BindGroup,
    pub indirect: wgpu::Buffer,
}

impl GeneratorBindings {
    pub fn new(
        device: &wgpu::Device,
        input: &GeneratorInput,
        layouts: (&wgpu::BindGroupLayout, &wgpu::BindGroupLayout),
        audio: &wgpu::Buffer,
    ) -> Result<Self, RenderError> {
        let invocation = &input.invocation;
        let storage_bytes =
            u64::from(invocation.capacity) * u64::from(invocation.program.graph.instance_stride);
        if storage_bytes > device.limits().max_storage_buffer_binding_size
            || invocation
                .dispatches
                .iter()
                .flatten()
                .any(|n| *n > device.limits().max_compute_workgroups_per_dimension)
        {
            return Err(RenderError::Invalid(
                "generator exceeds native device limits".into(),
            ));
        }
        let context = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Supplied generator context"),
            contents: &input.payload[..208],
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let parameters = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Supplied generator parameters"),
            contents: &input.payload[208..2256],
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let indirect = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Supplied generator indirect arguments"),
            contents: &input.payload[2256..2272],
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::INDIRECT,
        });
        let storage = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Time-addressed generator instances"),
            size: storage_bytes,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let entries = [
            wgpu::BindGroupEntry {
                binding: 0,
                resource: context.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: parameters.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: storage.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: indirect.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: audio.as_entire_binding(),
            },
        ];
        let compute = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Generator compute bindings"),
            layout: layouts.0,
            entries: &entries,
        });
        let render = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Generator draw bindings"),
            layout: layouts.1,
            entries: &[
                entries[0].clone(),
                entries[1].clone(),
                entries[2].clone(),
                entries[4].clone(),
            ],
        });
        Ok(Self {
            compute,
            render,
            indirect,
        })
    }

    pub fn audio(device: &wgpu::Device, supplied: Option<&[u8]>) -> wgpu::Buffer {
        let mut silent = vec![0; 9280];
        for (lane, value) in silent[..16].chunks_exact_mut(4).zip([128_u32, 16, 256, 0]) {
            lane.copy_from_slice(&value.to_le_bytes());
        }
        for (lane, value) in
            silent[16..32]
                .chunks_exact_mut(4)
                .zip([0_f32, 1.0 / 60.0, 30.0, 16000.0])
        {
            lane.copy_from_slice(&value.to_le_bytes());
        }
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Frame-shared generator audio analysis"),
            contents: match supplied {
                Some(audio) => audio,
                None => &silent,
            },
            usage: wgpu::BufferUsages::STORAGE,
        })
    }
}
