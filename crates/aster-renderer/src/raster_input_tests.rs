use std::collections::BTreeMap;

use aster_render_ir::{
    BufferResourceDescriptor, CompositionIdentity, ElementType, MediaFrameDescriptor, MediaKind,
    MediaSample, MediaSourceDescriptor, MediaTextureFormat, PrecompositionMediaPixels, PutResource,
    RasterOrigin, RasterPixelsDescriptor, RasterSample, ResourceDescriptor, ResourceHash,
    ResourceKind, ResourceRegistry,
};

use super::NativeRenderer;
use crate::image_input::ImageInput;

pub(super) struct RasterFixture;

impl RasterFixture {
    fn frame(
        registry: &mut ResourceRegistry,
        origin: RasterOrigin,
    ) -> Result<ResourceHash, Box<dyn std::error::Error>> {
        let source = ResourceDescriptor::MediaSource(MediaSourceDescriptor {
            source_id: CompositionIdentity::Unicode(format!("raster-{origin:?}")),
            content_identity: format!("pixels-{origin:?}"),
            authorization_scope: "raster-test".into(),
            media_kind: MediaKind::Raster,
        });
        let source_hash = ResourceHash::for_resource(ResourceKind::MediaSource, &source, &[])?;
        registry.put(
            PutResource {
                hash: source_hash.clone(),
                kind: ResourceKind::MediaSource,
                descriptor: source,
            },
            vec![],
        )?;
        let mut bounds_f64_le = [0_u32; 8];
        for (value, words) in [0.0_f64, 0.0, 2.0, 2.0]
            .into_iter()
            .zip(bounds_f64_le.chunks_exact_mut(2))
        {
            let bits = value.to_bits();
            words[0] = bits as u32;
            words[1] = (bits >> 32) as u32;
        }
        let descriptor = ResourceDescriptor::MediaFrame(MediaFrameDescriptor {
            source: source_hash,
            sample: MediaSample::Raster(RasterSample {
                origin,
                bounds_f64_le,
            }),
            width: 2,
            height: 2,
            format: MediaTextureFormat::Rgba8UnormSrgb,
        });
        let hash = ResourceHash::for_resource(ResourceKind::MediaFrame, &descriptor, &[])?;
        registry.put(
            PutResource {
                hash: hash.clone(),
                kind: ResourceKind::MediaFrame,
                descriptor,
            },
            vec![],
        )?;
        Ok(hash)
    }

    fn pixels(
        registry: &mut ResourceRegistry,
        frame: &ResourceHash,
        rgba: [u8; 4],
        typed: bool,
    ) -> Result<PrecompositionMediaPixels, Box<dyn std::error::Error>> {
        let bytes = rgba.repeat(4);
        let (kind, descriptor) = if typed {
            (
                ResourceKind::RasterPixels,
                ResourceDescriptor::RasterPixels(RasterPixelsDescriptor {
                    frame: frame.clone(),
                    width: 2,
                    height: 2,
                    format: MediaTextureFormat::Rgba8UnormSrgb,
                }),
            )
        } else {
            (
                ResourceKind::Buffer,
                ResourceDescriptor::Buffer(BufferResourceDescriptor {
                    element_type: ElementType::U8,
                    element_count: 16,
                    byte_length: 16,
                }),
            )
        };
        let pixels = ResourceHash::for_resource(kind, &descriptor, &bytes)?;
        registry.put(
            PutResource {
                hash: pixels.clone(),
                kind,
                descriptor,
            },
            bytes,
        )?;
        Ok(PrecompositionMediaPixels {
            frame: frame.clone(),
            pixels,
        })
    }

    pub fn verify_gpu(renderer: &mut NativeRenderer) -> Result<(), Box<dyn std::error::Error>> {
        for origin in [RasterOrigin::Text, RasterOrigin::Svg, RasterOrigin::Psd] {
            let mut registry = ResourceRegistry::new(Default::default())?;
            let frame = Self::frame(&mut registry, origin)?;
            let record = Self::pixels(&mut registry, &frame, [255, 0, 0, 127], true)?;
            let input = ImageInput::from_record(&record, &registry)?;
            let timeout = renderer.options.timeout;
            let gpu = (&renderer.device, &renderer.queue);
            let inputs = BTreeMap::from([(frame.clone(), input.clone())]);
            renderer
                .images
                .prepare(gpu, &inputs, &registry, 16, timeout)?;
            let before = renderer.images.statistics;
            renderer
                .images
                .prepare(gpu, &inputs, &registry, 16, timeout)?;
            assert_eq!(renderer.images.statistics.uploads, before.uploads);
            assert_eq!(renderer.images.statistics.hits, before.hits + 1);
            let unchanged = renderer.images.statistics;
            assert!(
                renderer
                    .images
                    .prepare(gpu, &inputs, &registry, 15, timeout)
                    .is_err()
            );
            assert_eq!(renderer.images.statistics, unchanged);
            registry.evict(&record.pixels)?;
            let changed = Self::pixels(&mut registry, &frame, [0, 255, 0, 63], true)?;
            let next = ImageInput::from_record(&changed, &registry)?;
            renderer.images.prepare(
                gpu,
                &BTreeMap::from([(frame, next.clone())]),
                &registry,
                16,
                timeout,
            )?;
            assert_eq!(renderer.images.statistics.uploads, unchanged.uploads + 1);
            assert!(renderer.images.binding(&input).is_err());
            assert!(renderer.images.binding(&next).is_ok());
        }
        Ok(())
    }
}

#[test]
fn raster_inputs_validate_typed_identity_and_supplied_pixel_generations()
-> Result<(), Box<dyn std::error::Error>> {
    let mut registry = ResourceRegistry::new(Default::default())?;
    let text = RasterFixture::frame(&mut registry, RasterOrigin::Text)?;
    let svg = RasterFixture::frame(&mut registry, RasterOrigin::Svg)?;
    let typed = RasterFixture::pixels(&mut registry, &text, [255, 64, 128, 127], true)?;
    let supplied = RasterFixture::pixels(&mut registry, &text, [255, 64, 128, 127], false)?;
    let a = ImageInput::from_record(&typed, &registry)?;
    let b = ImageInput::from_record(&supplied, &registry)?;
    assert_eq!(registry.resolve(&a.pixels)?, registry.resolve(&b.pixels)?);
    assert_eq!(a.frame, b.frame);
    assert!(
        ImageInput::from_record(
            &PrecompositionMediaPixels {
                frame: svg,
                pixels: typed.pixels.clone()
            },
            &registry
        )
        .is_err()
    );
    registry.evict(&typed.pixels)?;
    assert!(ImageInput::from_record(&typed, &registry).is_err());
    assert!(ImageInput::from_record(&supplied, &registry).is_ok());
    Ok(())
}
