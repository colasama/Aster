use crate::{RenderError, auxiliary_primary::AuxiliaryPrimaryTargets};

pub struct AuxiliaryPrimaryPipelines {
    pub(crate) shape: wgpu::RenderPipeline,
    pub(crate) media: wgpu::RenderPipeline,
}

impl AuxiliaryPrimaryPipelines {
    pub fn new(
        device: &wgpu::Device,
        catalog: &aster_shaders::ShaderCatalog,
        image_layout: &wgpu::BindGroupLayout,
    ) -> Result<Self, RenderError> {
        if device.limits().max_color_attachments < 5
            || device.limits().max_color_attachment_bytes_per_sample < 28
        {
            return Err(RenderError::Unsupported(
                "five primary auxiliary attachments require 28 bytes per sample".into(),
            ));
        }
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared auxiliary surface shader"),
            source: wgpu::ShaderSource::Wgsl(
                catalog.program("auxiliary-surface")?.source.clone().into(),
            ),
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Auxiliary media layout"),
            bind_group_layouts: &[Some(image_layout)],
            immediate_size: 0,
        });
        let attributes = [
            (0, 0, wgpu::VertexFormat::Float32x3),
            (1, 12, wgpu::VertexFormat::Float32x2),
            (2, 20, wgpu::VertexFormat::Float32x4),
            (4, 40, wgpu::VertexFormat::Float32x3),
            (6, 68, wgpu::VertexFormat::Float32x3),
            (8, 96, wgpu::VertexFormat::Float32x4),
            (10, 128, wgpu::VertexFormat::Float32x4),
        ]
        .map(|(shader_location, offset, format)| wgpu::VertexAttribute {
            shader_location,
            offset,
            format,
        });
        let ids = wgpu::vertex_attr_array![12 => Uint32, 13 => Uint32];
        let motion = wgpu::vertex_attr_array![14 => Float32x2];
        let targets = AuxiliaryPrimaryTargets::formats().map(|format| {
            Some(wgpu::ColorTargetState {
                format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })
        });
        let pipeline = |entry, layout| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Native primary auxiliary pipeline"),
                layout,
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some("surface_vertex"),
                    compilation_options: Default::default(),
                    buffers: &[
                        Some(wgpu::VertexBufferLayout {
                            array_stride: 160,
                            step_mode: wgpu::VertexStepMode::Vertex,
                            attributes: &attributes,
                        }),
                        Some(wgpu::VertexBufferLayout {
                            array_stride: 8,
                            step_mode: wgpu::VertexStepMode::Instance,
                            attributes: &ids,
                        }),
                        Some(wgpu::VertexBufferLayout {
                            array_stride: 8,
                            step_mode: wgpu::VertexStepMode::Vertex,
                            attributes: &motion,
                        }),
                    ],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some(entry),
                    compilation_options: Default::default(),
                    targets: &targets,
                }),
                primitive: Default::default(),
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Depth24Plus,
                    depth_write_enabled: Some(true),
                    depth_compare: Some(wgpu::CompareFunction::LessEqual),
                    stencil: Default::default(),
                    bias: Default::default(),
                }),
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        Ok(Self {
            shape: pipeline("surface_fragment", None),
            media: pipeline("media_fragment", Some(&layout)),
        })
    }
}
