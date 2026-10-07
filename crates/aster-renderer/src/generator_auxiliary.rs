use aster_render_ir::{GeneratorCull, GeneratorDepth};

use crate::{
    AuxiliaryPrimaryTargets, RenderError, generator_input::GeneratorInput,
    generator_program::GeneratorProgram,
};

/// Retained GPU handles from the same compute dispatch used by the beauty pass.
pub struct AuxiliaryGeneratorDraw {
    pub(crate) pipeline: wgpu::RenderPipeline,
    pub(crate) binding: wgpu::BindGroup,
    pub(crate) indirect: wgpu::Buffer,
}

impl GeneratorProgram {
    pub fn prepare_auxiliary(
        &mut self,
        device: &wgpu::Device,
        input: &GeneratorInput,
        layout: &wgpu::BindGroupLayout,
    ) -> Result<(), RenderError> {
        let index = input.invocation.variant_index as usize;
        let compiled = self
            .variants
            .get_mut(index)
            .ok_or_else(|| RenderError::Invalid("auxiliary generator variant absent".into()))?;
        if compiled.auxiliary.is_some() {
            return Ok(());
        }
        if device.limits().max_color_attachments < 5
            || device.limits().max_color_attachment_bytes_per_sample < 28
        {
            return Err(RenderError::Unsupported(
                "generator auxiliary MRT limits".into(),
            ));
        }
        let variant = &input.invocation.program.graph.render_variants[index];
        let auxiliary = variant
            .auxiliary
            .as_ref()
            .ok_or_else(|| RenderError::Invalid("generator auxiliary descriptor absent".into()))?;
        let source = input
            .shaders
            .get(&auxiliary.shader)
            .ok_or_else(|| RenderError::Invalid("generator auxiliary shader absent".into()))?;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Supplied generator auxiliary WGSL"),
            source: wgpu::ShaderSource::Naga(std::borrow::Cow::Owned(
                aster_shaders::GeneratorShader::parse(source).map_err(RenderError::Invalid)?,
            )),
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Generator auxiliary ABI"),
            bind_group_layouts: &[Some(layout)],
            immediate_size: 0,
        });
        let targets = AuxiliaryPrimaryTargets::formats().map(|format| {
            Some(wgpu::ColorTargetState {
                format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })
        });
        compiled.auxiliary = Some(
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Supplied generator auxiliary draw"),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some(&auxiliary.vertex_entry),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some(&auxiliary.fragment_entry),
                    compilation_options: Default::default(),
                    targets: &targets,
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
            }),
        );
        Ok(())
    }
}
