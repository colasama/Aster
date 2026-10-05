use std::collections::BTreeMap;

pub(crate) struct GeometryPipelines;

impl GeometryPipelines {
    pub(crate) fn create(
        device: &wgpu::Device,
        module: &wgpu::ShaderModule,
        layout: &wgpu::BindGroupLayout,
    ) -> BTreeMap<u8, wgpu::RenderPipeline> {
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Scene pipeline layout"),
            bind_group_layouts: &[Some(layout)],
            immediate_size: 0,
        });
        let attributes = [
            (0, wgpu::VertexFormat::Float32x3),
            (12, wgpu::VertexFormat::Float32x2),
            (20, wgpu::VertexFormat::Float32x4),
            (36, wgpu::VertexFormat::Float32),
            (40, wgpu::VertexFormat::Float32x3),
            (52, wgpu::VertexFormat::Float32x4),
            (68, wgpu::VertexFormat::Float32x3),
            (80, wgpu::VertexFormat::Float32x4),
            (96, wgpu::VertexFormat::Float32x4),
            (112, wgpu::VertexFormat::Float32x4),
            (128, wgpu::VertexFormat::Float32x4),
            (144, wgpu::VertexFormat::Float32x4),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (offset, format))| wgpu::VertexAttribute {
            format,
            offset,
            shader_location: index as u32,
        })
        .collect::<Vec<_>>();
        let mut pipelines = BTreeMap::new();
        for (index, (source, destination)) in [
            (wgpu::BlendFactor::One, wgpu::BlendFactor::OneMinusSrcAlpha),
            (wgpu::BlendFactor::One, wgpu::BlendFactor::One),
            (wgpu::BlendFactor::Dst, wgpu::BlendFactor::Zero),
            (wgpu::BlendFactor::One, wgpu::BlendFactor::OneMinusSrc),
        ]
        .into_iter()
        .enumerate()
        {
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Native geometry blend"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module,
                    entry_point: Some("vertex_main"),
                    compilation_options: Default::default(),
                    buffers: &[Some(wgpu::VertexBufferLayout {
                        array_stride: 160,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &attributes,
                    })],
                },
                fragment: Some(wgpu::FragmentState {
                    module,
                    entry_point: Some("fragment_main"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba16Float,
                        blend: Some(wgpu::BlendState {
                            color: wgpu::BlendComponent {
                                src_factor: source,
                                dst_factor: destination,
                                operation: wgpu::BlendOperation::Add,
                            },
                            alpha: wgpu::BlendComponent {
                                src_factor: wgpu::BlendFactor::One,
                                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                                operation: wgpu::BlendOperation::Add,
                            },
                        }),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
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
            });
            pipelines.insert(index as u8, pipeline);
        }
        pipelines
    }
}
