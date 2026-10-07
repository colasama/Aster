use aster_render_ir::{
    ContractLevel, Extent2d, OwnedFpln, PlanSlice, PostEffect, PostEffectStatus,
};
use aster_shaders::ShaderCatalog;
use wgpu::util::DeviceExt;

use crate::RenderError;

/// Immutable supplied surface controls; project state is not consulted during recording.
pub struct SurfacePostPlan {
    size: Extent2d,
    uniforms: Vec<u8>,
    ready: bool,
}

impl SurfacePostPlan {
    pub fn new(plan: &OwnedFpln) -> Result<Self, RenderError> {
        let Some(PlanSlice::PostEffect(effect)) = plan.metadata.slices.first() else {
            return Err(RenderError::Invalid("surface post plan missing".into()));
        };
        if plan.metadata.contract_level != ContractLevel::PostEffectSliceV1
            || plan.metadata.slices.len() != 1
            || !matches!(effect.effect, PostEffect::Surface { .. })
        {
            return Err(RenderError::Unsupported("non-surface post route".into()));
        }
        let uniforms = plan.blob(effect.blob_index as usize)?;
        effect.validate_bytes(uniforms, &plan.metadata.header)?;
        Ok(Self {
            size: plan.metadata.header.render_target,
            uniforms: uniforms.to_vec(),
            ready: effect.status == PostEffectStatus::Ready,
        })
    }
}

/// Retained GPU execution of selection isolation and vector motion blur.
pub struct SurfacePostPipeline {
    pipeline: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    format: wgpu::TextureFormat,
}

impl SurfacePostPipeline {
    pub fn new(
        device: &wgpu::Device,
        catalog: &ShaderCatalog,
        format: wgpu::TextureFormat,
    ) -> Result<Self, RenderError> {
        if !matches!(
            format,
            wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Bgra8Unorm
        ) {
            return Err(RenderError::Unsupported("surface display format".into()));
        }
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared surface post effects"),
            source: wgpu::ShaderSource::Wgsl(
                catalog
                    .program("surface-post-effects")?
                    .source
                    .clone()
                    .into(),
            ),
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Supplied surface post pipeline"),
            layout: None,
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vertex_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fragment_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        Ok(Self {
            pipeline,
            format,
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                min_filter: wgpu::FilterMode::Linear,
                mag_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
        })
    }

    /// Inputs are linear HDR color, integer object IDs, and motion vectors, in that order.
    /// A captured skip returns false and leaves the destination untouched.
    pub fn record(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        plan: &SurfacePostPlan,
        inputs: [&wgpu::Texture; 3],
        output: &wgpu::Texture,
    ) -> Result<bool, RenderError> {
        if !plan.ready {
            return Ok(false);
        }
        for (texture, format, usage) in [
            (
                inputs[0],
                wgpu::TextureFormat::Rgba16Float,
                wgpu::TextureUsages::TEXTURE_BINDING,
            ),
            (
                inputs[1],
                wgpu::TextureFormat::R32Uint,
                wgpu::TextureUsages::TEXTURE_BINDING,
            ),
            (
                inputs[2],
                wgpu::TextureFormat::Rg16Float,
                wgpu::TextureUsages::TEXTURE_BINDING,
            ),
            (output, self.format, wgpu::TextureUsages::RENDER_ATTACHMENT),
        ] {
            if texture.width() != plan.size.width
                || texture.height() != plan.size.height
                || texture.depth_or_array_layers() != 1
                || texture.sample_count() != 1
                || texture.dimension() != wgpu::TextureDimension::D2
                || texture.mip_level_count() != 1
                || texture.format() != format
                || !texture.usage().contains(usage)
            {
                return Err(RenderError::Invalid(
                    "surface post attachment contract differs".into(),
                ));
            }
        }
        let views = inputs.map(|texture| texture.create_view(&Default::default()));
        let uniforms = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Supplied surface controls"),
            contents: &plan.uniforms,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let binding = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Surface post inputs"),
            layout: &self.pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&views[0]),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: uniforms.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&views[1]),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&views[2]),
                },
            ],
        });
        let view = output.create_view(&Default::default());
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Native surface post"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &binding, &[]);
        pass.draw(0..3, 0..1);
        Ok(true)
    }
}
