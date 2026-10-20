use std::{path::PathBuf, sync::mpsc, time::Duration};

use aster_render_ir::{DecodeLimits, FplnCodec, PlanSlice, RootTextureReference};

use super::{NativeOptions, NativeRenderer};
use crate::{AuxiliaryPrimaryPipelines, AuxiliaryPrimaryPlan, AuxiliaryPrimaryTargets};

struct AuxiliaryFixture {
    root: PathBuf,
    renderer: NativeRenderer,
    pipelines: AuxiliaryPrimaryPipelines,
    bindings: Vec<(RootTextureReference, wgpu::BindGroup)>,
}

impl AuxiliaryFixture {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let renderer = NativeRenderer::new(NativeOptions {
            effect_regions: true,
            layer_cache_bytes: 67_108_864,
            effect_pipeline_entries: 16,
            gpu_timestamps: false,
            dxcompiler: cfg!(target_os = "windows")
                .then(|| root.join("node_modules/electron/dist/dxcompiler.dll")),
            backend: if cfg!(target_os = "windows") {
                aster_render::NativeBackend::Dx12
            } else if cfg!(target_os = "macos") {
                aster_render::NativeBackend::Metal
            } else {
                aster_render::NativeBackend::Vulkan
            },
            adapter_name: None,
            gpu_budget_bytes: 4 * 1024 * 1024,
            timeout: Duration::from_secs(30),
        })?;
        let scope = renderer
            .device
            .push_error_scope(wgpu::ErrorFilter::Validation);
        let pipelines = AuxiliaryPrimaryPipelines::new(
            &renderer.device,
            &aster_shaders::ShaderCatalog::embedded()?,
            &renderer.images.layout,
        )?;
        let base = root.join("tests/parity/native-auxiliary-primary");
        let captured = FplnCodec::decode(
            std::fs::read(base.join("basic-auxiliary.fpln"))?,
            &DecodeLimits::default(),
        )?;
        let Some(PlanSlice::Auxiliary(slice)) = captured.metadata.slices.first() else {
            return Err("fixture draws absent".into());
        };
        let sampler = renderer.device.create_sampler(&Default::default());
        let mut bindings = Vec::new();
        for (index, draw) in slice.draws.iter().skip(1).enumerate() {
            let texture = renderer.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Frozen auxiliary alpha texture"),
                size: wgpu::Extent3d {
                    width: 4,
                    height: 4,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            renderer.queue.write_texture(
                texture.as_image_copy(),
                &std::fs::read(base.join(format!("media-{index}.bin")))?,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(16),
                    rows_per_image: Some(4),
                },
                texture.size(),
            );
            let view = texture.create_view(&Default::default());
            let binding = renderer
                .device
                .create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Frozen auxiliary media binding"),
                    layout: &renderer.images.layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(&view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::Sampler(&sampler),
                        },
                    ],
                });
            bindings.push((draw.texture.clone(), binding));
        }
        if let Some(error) = pollster::block_on(scope.pop()) {
            return Err(error.to_string().into());
        }
        Ok(Self {
            root,
            renderer,
            pipelines,
            bindings,
        })
    }

    fn plan(
        &self,
        id: &str,
        name: &str,
    ) -> Result<aster_render_ir::OwnedFpln, Box<dyn std::error::Error>> {
        let bytes = std::fs::read(self.root.join(format!(
            "tests/parity/native-auxiliary-primary/{id}-{name}.fpln"
        )))?;
        Ok(FplnCodec::decode(bytes, &DecodeLimits::default())?)
    }

    fn render(
        &self,
        plan: &AuxiliaryPrimaryPlan,
        targets: &AuxiliaryPrimaryTargets,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let device = &self.renderer.device;
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = device.create_command_encoder(&Default::default());
        let bindings = plan
            .draws
            .iter()
            .map(|draw| {
                self.bindings
                    .iter()
                    .find(|(key, _)| key == &draw.texture)
                    .map(|(_, b)| b)
            })
            .collect::<Vec<_>>();
        self.pipelines.record(
            device,
            &mut encoder,
            plan,
            targets,
            (&bindings, &Default::default()),
        )?;
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Primary auxiliary diagnostic readback"),
            size: 64 * 48 * 28,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut offset = 0;
        for (texture, bpp) in targets.colors.iter().zip([8, 4, 4, 8, 4]) {
            encoder.copy_texture_to_buffer(
                texture.as_image_copy(),
                wgpu::TexelCopyBufferInfo {
                    buffer: &readback,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset,
                        bytes_per_row: Some(64 * bpp),
                        rows_per_image: Some(48),
                    },
                },
                texture.size(),
            );
            offset += 64 * 48 * u64::from(bpp);
        }
        let submission = self.renderer.queue.submit([encoder.finish()]);
        if let Some(error) = pollster::block_on(scope.pop()) {
            return Err(error.to_string().into());
        }
        let (sender, receiver) = mpsc::channel();
        readback
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });
        device.poll(wgpu::PollType::Wait {
            submission_index: Some(submission),
            timeout: Some(Duration::from_secs(30)),
        })?;
        receiver.recv_timeout(Duration::from_secs(30))??;
        let bytes = readback.slice(..).get_mapped_range()?.to_vec();
        readback.unmap();
        Ok(bytes)
    }
}

#[test]
#[ignore = "requires GPU"]
fn auxiliary_primary_supplied_gpu_outputs_and_controls() -> Result<(), Box<dyn std::error::Error>> {
    let fixture = AuxiliaryFixture::new()?;
    let output = std::env::var_os("ASTER_AUXILIARY_PRIMARY_OUTPUT").map(PathBuf::from);
    if let Some(path) = &output {
        std::fs::create_dir_all(path)?;
    }
    for id in ["basic", "tier0", "tier1", "tier2", "no-motion", "cleared"] {
        let scene = fixture.plan(id, "scene")?;
        let auxiliary = fixture.plan(id, "auxiliary")?;
        let plan = AuxiliaryPrimaryPlan::new(&scene, &auxiliary)?;
        assert!(
            AuxiliaryPrimaryTargets::new(
                &fixture.renderer.device,
                &plan,
                plan.required_bytes() - 1
            )
            .is_err()
        );
        let budget = if id == "cleared" {
            AuxiliaryPrimaryPlan::new(&scene, &fixture.plan(id, "prime")?)?.required_bytes()
        } else {
            plan.required_bytes()
        };
        let targets = AuxiliaryPrimaryTargets::new(&fixture.renderer.device, &plan, budget)?;
        if id == "cleared" {
            let prime = AuxiliaryPrimaryPlan::new(&scene, &fixture.plan(id, "prime")?)?;
            assert!(
                fixture
                    .render(&prime, &targets)?
                    .iter()
                    .any(|byte| *byte != 0)
            );
        }
        let actual = fixture.render(&plan, &targets)?;
        let reference = std::fs::read(
            fixture
                .root
                .join(format!("tests/parity/auxiliary-replay/reference/{id}.bin")),
        )?;
        assert_eq!(actual.len(), 64 * 48 * 28);
        assert!(
            actual == reference[..actual.len()],
            "primary attachments differ: {id}"
        );
        let retained_plan = if id == "cleared" {
            AuxiliaryPrimaryPlan::new(&scene, &fixture.plan(id, "prime")?)?
        } else {
            AuxiliaryPrimaryPlan::new(&scene, &auxiliary)?
        };
        let retained = AuxiliaryPrimaryTargets::allocate(
            &fixture.renderer.device,
            retained_plan.size,
            [
                retained_plan.vertices.len() as u64,
                retained_plan.ids.len() as u64,
                retained_plan.motion.len() as u64,
            ],
            budget,
        )?;
        if id == "cleared" {
            assert!(
                fixture
                    .render(&retained_plan, &retained)?
                    .iter()
                    .any(|byte| *byte != 0)
            );
        }
        assert_eq!(
            fixture.render(&plan, &retained)?,
            actual,
            "retained attributes differ: {id}"
        );
        if let Some(path) = &output {
            use std::io::Write;
            let temporary = path.join(format!("{id}.bin.tmp"));
            let destination = path.join(format!("{id}.bin"));
            if destination.exists() {
                return Err("auxiliary output exists".into());
            }
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&actual)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(temporary, destination)?;
        }
        if id == "basic" {
            let mut changed = AuxiliaryPrimaryPlan::new(&scene, &auxiliary)?;
            changed.ids[..4].copy_from_slice(&u32::MAX.to_le_bytes());
            let altered = fixture.render(&changed, &targets)?;
            assert_ne!(
                &altered[64 * 48 * 8..64 * 48 * 12],
                &actual[64 * 48 * 8..64 * 48 * 12]
            );
            assert!(
                altered[64 * 48 * 8..64 * 48 * 12]
                    .chunks_exact(4)
                    .any(|lane| lane == u32::MAX.to_le_bytes())
            );
            let mut changed = AuxiliaryPrimaryPlan::new(&scene, &auxiliary)?;
            changed.motion.fill(0);
            assert_ne!(
                fixture.render(&changed, &targets)?[64 * 48 * 24..],
                actual[64 * 48 * 24..]
            );
            let mut changed = AuxiliaryPrimaryPlan::new(&scene, &auxiliary)?;
            changed.draws[1].vertex_count = 0;
            assert_ne!(fixture.render(&changed, &targets)?, actual);
            let mut changed = AuxiliaryPrimaryPlan::new(&scene, &auxiliary)?;
            changed.draws[1].texture = RootTextureReference::None;
            assert_ne!(fixture.render(&changed, &targets)?, actual);
            assert_eq!(fixture.render(&plan, &targets)?, actual);
        }
        let mut wrong = fixture.plan(id, "scene")?;
        wrong.metadata.header.project_revision += 1;
        assert!(AuxiliaryPrimaryPlan::new(&wrong, &auxiliary).is_err());
        let mut generated = fixture.plan(id, "auxiliary")?;
        let Some(PlanSlice::Auxiliary(slice)) = generated.metadata.slices.first_mut() else {
            return Err("slice missing".into());
        };
        slice
            .generators
            .push(scene.metadata.header.composition_id.clone());
        if id == "cleared" {
            assert!(AuxiliaryPrimaryPlan::new(&scene, &generated).is_err());
        } else {
            let generated = AuxiliaryPrimaryPlan::new(&scene, &generated)?;
            let mut encoder = fixture
                .renderer
                .device
                .create_command_encoder(&Default::default());
            assert!(matches!(
                fixture.pipelines.record(
                    &fixture.renderer.device,
                    &mut encoder,
                    &generated,
                    &targets,
                    (&[], &Default::default()),
                ),
                Err(crate::RenderError::Invalid(message))
                    if message == "auxiliary generator binding absent"
            ));
        }
    }
    Ok(())
}
