use std::collections::BTreeMap;

use aster_render_ir::{GeneratorBlend, GeneratorCull, GeneratorDepth};

use crate::{RenderError, generator_input::GeneratorInput};

pub(crate) struct GeneratorProgram {
    pub compute: Vec<wgpu::ComputePipeline>,
    pub variants: Vec<GeneratorVariant>,
}

pub(crate) struct GeneratorVariant {
    pub mode: GeneratorBlend,
    pub pipelines: BTreeMap<u8, wgpu::RenderPipeline>,
}

impl GeneratorProgram {
    pub fn new(
        device: &wgpu::Device,
        input: &GeneratorInput,
        compute_layout: &wgpu::BindGroupLayout,
        render_layout: &wgpu::BindGroupLayout,
    ) -> Result<Self, RenderError> {
        let modules = input
            .shaders
            .iter()
            .map(|(hash, source)| {
                let module =
                    aster_shaders::GeneratorShader::parse(source).map_err(RenderError::Invalid)?;
                Ok((
                    hash.clone(),
                    device.create_shader_module(wgpu::ShaderModuleDescriptor {
                        label: Some("Supplied generator WGSL"),
                        source: wgpu::ShaderSource::Naga(std::borrow::Cow::Owned(module)),
                    }),
                ))
            })
            .collect::<Result<BTreeMap<_, _>, RenderError>>()?;
        let compute_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Generator compute ABI"),
            bind_group_layouts: &[Some(compute_layout)],
            immediate_size: 0,
        });
        let render_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Generator render ABI"),
            bind_group_layouts: &[Some(render_layout)],
            immediate_size: 0,
        });
        let graph = &input.invocation.program.graph;
        let mut compute = Vec::new();
        for pass in &graph.compute_passes {
            let module = modules
                .get(&pass.shader)
                .ok_or_else(|| RenderError::Invalid("generator compute shader absent".into()))?;
            compute.push(
                device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("Supplied generator compute"),
                    layout: Some(&compute_layout),
                    module,
                    entry_point: Some(&pass.entry_point),
                    compilation_options: Default::default(),
                    cache: None,
                }),
            );
        }
        let mut variants = Vec::new();
        for variant in &graph.render_variants {
            let module = modules
                .get(&variant.shader)
                .ok_or_else(|| RenderError::Invalid("generator draw shader absent".into()))?;
            let modes = match variant.blend {
                GeneratorBlend::Layer => vec![0, 1, 2, 3],
                GeneratorBlend::Normal => vec![0],
                GeneratorBlend::Add => vec![1],
                GeneratorBlend::Multiply => vec![2],
                GeneratorBlend::Screen => vec![3],
                GeneratorBlend::Overlay => {
                    return Err(RenderError::Unsupported(
                        "generator fixed overlay blend".into(),
                    ));
                }
            };
            let mut pipelines = BTreeMap::new();
            for mode in modes {
                let (source, destination) = match mode {
                    1 => (wgpu::BlendFactor::One, wgpu::BlendFactor::One),
                    2 => (wgpu::BlendFactor::Dst, wgpu::BlendFactor::Zero),
                    3 => (wgpu::BlendFactor::One, wgpu::BlendFactor::OneMinusSrc),
                    _ => (wgpu::BlendFactor::One, wgpu::BlendFactor::OneMinusSrcAlpha),
                };
                let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("Supplied generator draw"),
                    layout: Some(&render_layout),
                    vertex: wgpu::VertexState {
                        module,
                        entry_point: Some(&variant.vertex_entry),
                        compilation_options: Default::default(),
                        buffers: &[],
                    },
                    fragment: Some(wgpu::FragmentState {
                        module,
                        entry_point: Some(&variant.fragment_entry),
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
                    primitive: wgpu::PrimitiveState {
                        cull_mode: match variant.cull {
                            GeneratorCull::None => None,
                            GeneratorCull::Front => Some(wgpu::Face::Front),
                            GeneratorCull::Back => Some(wgpu::Face::Back),
                        },
                        ..Default::default()
                    },
                    depth_stencil: Some(wgpu::DepthStencilState {
                        format: wgpu::TextureFormat::Depth24Plus,
                        depth_write_enabled: Some(variant.depth == GeneratorDepth::ReadWrite),
                        depth_compare: Some(if variant.depth == GeneratorDepth::None {
                            wgpu::CompareFunction::Always
                        } else {
                            wgpu::CompareFunction::LessEqual
                        }),
                        stencil: Default::default(),
                        bias: Default::default(),
                    }),
                    multisample: Default::default(),
                    multiview_mask: None,
                    cache: None,
                });
                pipelines.insert(
                    if variant.blend == GeneratorBlend::Layer {
                        mode
                    } else {
                        0
                    },
                    pipeline,
                );
            }
            variants.push(GeneratorVariant {
                mode: variant.blend,
                pipelines,
            });
        }
        Ok(Self { compute, variants })
    }
}
