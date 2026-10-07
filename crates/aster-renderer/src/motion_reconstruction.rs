use crate::{RenderError, frame_motion::FrameMotion};
use wgpu::util::DeviceExt;

pub(crate) struct MotionReconstruction {
    pipelines: [wgpu::RenderPipeline; 3],
    sampler: wgpu::Sampler,
}

impl MotionReconstruction {
    pub fn new(
        device: &wgpu::Device,
        catalog: &aster_shaders::ShaderCatalog,
    ) -> Result<Self, RenderError> {
        let program = catalog.program("motion-blur")?;
        let constants = program.pipeline_constants(&Default::default())?;
        let constants = constants
            .iter()
            .map(|(k, v)| (k.as_str(), *v))
            .collect::<Vec<_>>();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared HDR motion reconstruction"),
            source: wgpu::ShaderSource::Naga(std::borrow::Cow::Owned(
                aster_shaders::GeneratorShader::parse(&program.source)
                    .map_err(RenderError::Invalid)?,
            )),
        });
        let pipelines = [
            "tile_max_fragment",
            "neighbor_max_fragment",
            "reconstruct_fragment",
        ]
        .map(|entry| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(entry),
                layout: None,
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some("vertex_main"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some(entry),
                    compilation_options: wgpu::PipelineCompilationOptions {
                        constants: &constants,
                        ..Default::default()
                    },
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba16Float,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        });
        Ok(Self {
            pipelines,
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                min_filter: wgpu::FilterMode::Linear,
                mag_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
        })
    }

    /// Scene-linear color remains GPU resident across all three passes.
    pub fn record(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        plan: &FrameMotion,
        inputs: [&wgpu::Texture; 3],
        targets: &[wgpu::Texture; 3],
    ) -> Result<(), RenderError> {
        for (texture, size, format) in inputs
            .iter()
            .zip([
                wgpu::TextureFormat::Rgba16Float,
                wgpu::TextureFormat::Rg16Float,
                wgpu::TextureFormat::R32Uint,
            ])
            .map(|(texture, format)| (*texture, plan.size, format))
            .chain(targets.iter().enumerate().map(|(i, t)| {
                (
                    t,
                    if i == 2 { plan.size } else { plan.tiles },
                    wgpu::TextureFormat::Rgba16Float,
                )
            }))
        {
            if texture.width() != size.width
                || texture.height() != size.height
                || texture.format() != format
                || texture.depth_or_array_layers() != 1
                || texture.sample_count() != 1
                || texture.mip_level_count() != 1
                || !texture
                    .usage()
                    .contains(wgpu::TextureUsages::TEXTURE_BINDING)
            {
                return Err(RenderError::Invalid(
                    "motion attachment contract differs".into(),
                ));
            }
        }
        let inputs = inputs.map(|t| t.create_view(&Default::default()));
        let outputs = targets
            .each_ref()
            .map(|t| t.create_view(&Default::default()));
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Supplied motion reconstruction controls"),
            contents: &plan.uniforms,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let texture = |binding, view| wgpu::BindGroupEntry {
            binding,
            resource: wgpu::BindingResource::TextureView(view),
        };
        let groups = [
            vec![
                texture(0, &inputs[1]),
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: uniform.as_entire_binding(),
                },
            ],
            vec![texture(2, &outputs[0])],
            vec![
                texture(3, &inputs[0]),
                texture(4, &inputs[1]),
                texture(5, &inputs[2]),
                texture(6, &outputs[1]),
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 8,
                    resource: uniform.as_entire_binding(),
                },
            ],
        ];
        for (index, entries) in groups.iter().enumerate() {
            let binding = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Motion reconstruction inputs"),
                layout: &self.pipelines[index].get_bind_group_layout(0),
                entries,
            });
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Native HDR motion pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &outputs[index],
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.pipelines[index]);
            pass.set_bind_group(0, &binding, &[]);
            pass.draw(0..3, 0..1);
        }
        Ok(())
    }
}
