use std::{collections::BTreeSet, path::PathBuf, sync::Arc, time::Duration};

use super::{NativeOptions, NativeRenderer};
use crate::{GlyphTextDraw, GlyphTextPlan, NativeGlyphInput, SuppliedFrame, TemporalTextPlan};
use aster_render_ir::{
    BufferResourceDescriptor, DecodeLimits, ElementType, Extent2d, FplnCodec, MediaSample,
    PlanSlice, RasterOrigin, ResourceDescriptor, ResourceKind, ResourceMessage, ResourceRegistry,
    VerifiedResource,
};
use aster_text::{
    FontFaceId, GlyphGeneration, GlyphGenerationConfig, GlyphGenerations, GlyphHinting, GlyphImage,
    GlyphImageFormat, GlyphRasterKey,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct FileRef {
    path: String,
}
#[derive(Deserialize)]
struct ResourceRef {
    message: ResourceMessage,
}
#[derive(Deserialize)]
struct CapturedFrame {
    mode: String,
    replay: FileRef,
    resources: Vec<ResourceRef>,
}
#[derive(Deserialize)]
struct Manifest {
    frames: Vec<CapturedFrame>,
}

struct RoutingFixture {
    root: PathBuf,
    atlas: Arc<GlyphGeneration>,
}

impl RoutingFixture {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let mut generations = GlyphGenerations::new(GlyphGenerationConfig {
            glyph_page_dimension: 256,
            ..Default::default()
        })?;
        let image = Arc::new(GlyphImage {
            key: GlyphRasterKey {
                face: FontFaceId {
                    sha256: [0; 32],
                    index: 0,
                },
                variations: Vec::new(),
                glyph_id: 1,
                size_bits: 16f32.to_bits(),
                phase_bits: [0; 2],
                hinting: GlyphHinting::None,
                stroke_bits: None,
                foreground: [255; 4],
                prefer_bitmap: false,
            },
            format: GlyphImageFormat::Coverage,
            width: 32,
            height: 16,
            origin: [0; 2],
            nominal_advance: 32.,
            data: vec![255; 32 * 16],
        });
        Ok(Self {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
            atlas: generations.prepare(&[image])?,
        })
    }

    fn build(
        &self,
        mode: &str,
        temporal: bool,
        native: bool,
        blue: bool,
    ) -> Result<(SuppliedFrame, ResourceRegistry), Box<dyn std::error::Error>> {
        let base = self.root.join("tests/parity/native-media-frame");
        let manifest: Manifest =
            serde_json::from_slice(&std::fs::read(base.join("manifest.json"))?)?;
        let capture = manifest
            .frames
            .into_iter()
            .find(|f| f.mode == mode)
            .ok_or("fixture mode absent")?;
        let limits = DecodeLimits::default();
        let mut plan =
            FplnCodec::decode(std::fs::read(self.root.join(capture.replay.path))?, &limits)?;
        let mut registry = ResourceRegistry::new(Default::default())?;
        let mut resources = capture
            .resources
            .into_iter()
            .map(|r| match r.message {
                ResourceMessage::PutResource(p) => Ok(p),
                _ => Err("unexpected fixture eviction"),
            })
            .collect::<Result<Vec<_>, _>>()?;
        resources.sort_by_key(|r| match r.kind {
            ResourceKind::MediaSource => 0,
            ResourceKind::MediaFrame => 1,
            _ => 2,
        });
        for resource in resources {
            let bytes = std::fs::read(base.join(format!("resources/{}.bin", resource.hash.0)))?;
            registry.put(resource, bytes)?;
        }
        let Some(PlanSlice::FrameBundle(bundle)) = plan.metadata.slices.first_mut() else {
            return Err("frame bundle absent".into());
        };
        let mut outputs = BTreeSet::new();
        for hash in &bundle.temporal {
            let stage = FplnCodec::decode(registry.resolve(hash)?.to_vec(), &limits)?;
            outputs.insert(TemporalTextPlan::new(&stage)?.output);
        }
        assert!(!outputs.is_empty());
        if !temporal {
            bundle.temporal.clear();
        }
        let mut admitted = Vec::new();
        let mut pixels = Vec::new();
        for mut record in std::mem::take(&mut bundle.media_pixels) {
            let ResourceDescriptor::MediaFrame(descriptor) =
                registry.descriptor(&record.frame)?.clone()
            else {
                return Err("media frame absent".into());
            };
            let text = matches!(&descriptor.sample, MediaSample::Raster(sample) if sample.origin == RasterOrigin::Text);
            let selected = text && (outputs.contains(&record.frame) != temporal);
            if text && (!temporal || selected) {
                plan.metadata.resources.retain(|h| h != &record.pixels);
                registry.evict(&record.pixels)?;
            }
            if text && !temporal && !selected {
                continue;
            }
            if !selected {
                pixels.push(record);
                continue;
            }
            let color = if blue {
                [0., 0., 1., 1.]
            } else {
                [1., 0., 0., 1.]
            };
            if native {
                admitted.push(NativeGlyphInput::new(
                    record.frame,
                    Arc::clone(&self.atlas),
                    GlyphTextPlan {
                        size: Extent2d {
                            width: descriptor.width,
                            height: descriptor.height,
                        },
                        draws: vec![GlyphTextDraw {
                            placement: 0,
                            baseline: [32., 24.],
                            transform: [1., 0., 0., 1., 0., 0.],
                            color,
                            clip: [0, 0, descriptor.width, descriptor.height],
                        }],
                    },
                    Default::default(),
                    16 * 1024 * 1024,
                )?);
            } else {
                let mut rgba = vec![0; descriptor.width as usize * descriptor.height as usize * 4];
                for y in 24..40 {
                    for x in 32..64 {
                        let start = (y * descriptor.width as usize + x) * 4;
                        rgba[start..start + 4].copy_from_slice(if blue {
                            &[0, 0, 255, 255]
                        } else {
                            &[255, 0, 0, 255]
                        });
                    }
                }
                let packet = VerifiedResource::new(
                    ResourceKind::Buffer,
                    ResourceDescriptor::Buffer(BufferResourceDescriptor {
                        element_type: ElementType::U8,
                        element_count: rgba.len() as u32,
                        byte_length: rgba.len() as u32,
                    }),
                    rgba,
                )?;
                record.pixels = packet.request().hash.clone();
                plan.metadata.resources.push(record.pixels.clone());
                registry.put_verified(packet)?;
                pixels.push(record);
            }
        }
        bundle.media_pixels = pixels;
        let counts = [
            bundle.shadow_map_size,
            bundle.effects.len() as u32,
            bundle.generators.len() as u32,
            u32::from(bundle.precompositions.is_some()),
            bundle.media_pixels.len() as u32,
            bundle.temporal.len() as u32,
        ];
        let blob = counts
            .into_iter()
            .flat_map(u32::to_le_bytes)
            .collect::<Vec<_>>();
        plan.metadata.resources.sort();
        plan.metadata.resources.dedup();
        let encoded = FplnCodec::encode(plan.metadata, &[&blob], &limits)?;
        let decode = || FplnCodec::decode(encoded.clone(), &limits);
        if native {
            assert!(!admitted.is_empty());
            assert!(
                SuppliedFrame::new(decode()?, &registry, &limits, &[]).is_err(),
                "External bundles still require pixel payloads"
            );
            let mut duplicate = admitted.clone();
            duplicate.push(admitted[0].clone());
            assert!(
                SuppliedFrame::with_native_glyphs(
                    decode()?,
                    &registry,
                    &limits,
                    &[],
                    &[],
                    duplicate
                )
                .is_err()
            );
            assert!(
                SuppliedFrame::with_native_glyphs(
                    decode()?,
                    &registry,
                    &limits,
                    &[],
                    &[],
                    admitted[1..].to_vec()
                )
                .is_err()
            );
        }
        let frame =
            SuppliedFrame::with_native_glyphs(decode()?, &registry, &limits, &[], &[], admitted)?;
        Ok((frame, registry))
    }
}

#[test]
#[ignore = "requires GPU"]
fn native_glyph_frame_routing_without_cpu_rasters() -> Result<(), Box<dyn std::error::Error>> {
    let fixture = RoutingFixture::new()?;
    let mut renderer = NativeRenderer::new(NativeOptions {
        backend: if cfg!(windows) {
            aster_render::NativeBackend::Dx12
        } else if cfg!(target_os = "macos") {
            aster_render::NativeBackend::Metal
        } else {
            aster_render::NativeBackend::Vulkan
        },
        adapter_name: None,
        dxcompiler: cfg!(windows).then(|| {
            fixture
                .root
                .join("node_modules/electron/dist/dxcompiler.dll")
        }),
        gpu_budget_bytes: 64 * 1024 * 1024,
        layer_cache_bytes: 8 * 1024 * 1024,
        effect_regions: true,
        effect_pipeline_entries: 16,
        gpu_timestamps: false,
        timeout: Duration::from_secs(30),
    })?;
    for mode in ["root", "recursive"] {
        for temporal in [false, true] {
            let mut references = Vec::new();
            for blue in [false, true] {
                let (expected, reference_registry) = fixture.build(mode, temporal, false, blue)?;
                let reference = renderer.render(&expected, &reference_registry)?;
                references.push(renderer.read_rgba(&reference)?);
            }
            assert_ne!(
                references[0], references[1],
                "Fixture must expose stale color generations"
            );
            for (blue, reference_pixels) in [false, true].into_iter().zip(references) {
                let (native, registry) = fixture.build(mode, temporal, true, blue)?;
                assert!(native.glyphs.bytes > 0);
                for input in native.glyphs.inputs.values() {
                    assert!(registry.resolve(&input.generation).is_err());
                }
                let before = renderer.images.statistics.uploads;
                let output = renderer.render(&native, &registry)?;
                assert_eq!(
                    renderer.images.statistics.uploads, before,
                    "Native text must never upload full-frame CPU pixels"
                );
                assert_eq!(
                    renderer.read_rgba(&output)?,
                    reference_pixels,
                    "{mode} temporal={temporal} blue={blue}"
                );
                drop(output);
                let input = native
                    .glyphs
                    .images
                    .values()
                    .next()
                    .ok_or("native image absent")?;
                let retained = renderer.images.texture(input)?.clone();
                let repeated = renderer.render(&native, &registry)?;
                assert_eq!(
                    renderer.images.texture(input)?,
                    &retained,
                    "Unchanged immutable output must be reused"
                );
                assert_eq!(renderer.read_rgba(&repeated)?, reference_pixels);
                drop(repeated);
                drop(retained);
                let budget = renderer.options.gpu_budget_bytes;
                renderer.options.gpu_budget_bytes = native.glyphs.bytes - 1;
                assert!(renderer.render(&native, &registry).is_err());
                renderer.options.gpu_budget_bytes = budget;
                let recovered = renderer.render(&native, &registry)?;
                assert_eq!(renderer.read_rgba(&recovered)?, reference_pixels);
            }
        }
    }
    Ok(())
}
