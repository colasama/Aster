use super::*;
use std::sync::Arc;

impl StreamMetadata {
    fn fixture(index: u32, default: bool, width: u32, height: u32) -> StreamMetadata {
        StreamMetadata {
            index,
            kind: StreamKind::Video,
            codec: "av1".into(),
            timebase: Timebase {
                numerator: 1,
                denominator: 90_000,
            },
            default,
            width,
            height,
            frame_rate: Some(Timebase {
                numerator: 1,
                denominator: 60,
            }),
            sample_rate: 0,
            channels: 0,
            color: ColorMetadata::default(),
        }
    }
}

#[test]
fn rescales_large_timestamps_exactly() -> Result<(), Box<dyn std::error::Error>> {
    let clock = Timebase::new(1, 90_000)?;
    let milliseconds = Timebase::new(1, 1_000)?;
    assert_eq!(clock.rescale(810_000, milliseconds), Ok(9_000));
    assert_eq!(
        Timebase::new(2, 4),
        Ok(Timebase {
            numerator: 1,
            denominator: 2
        })
    );
    Ok(())
}

#[test]
fn probes_metadata_and_selects_default_stream() -> Result<(), Box<dyn std::error::Error>> {
    let metadata = ContainerMetadata {
        format: "matroska".into(),
        duration_ticks: 90_000,
        timebase: Timebase::new(1, 1_000)?,
        streams: vec![
            StreamMetadata::fixture(0, false, 3840, 2160),
            StreamMetadata::fixture(1, true, 1920, 1080),
        ],
    };
    let bytes = serde_json::to_vec(&metadata)?;
    let parsed = ContainerMetadata::parse(&bytes, &MetadataLimits::default())?;
    assert_eq!(parsed.select_video_stream()?.index, 1);
    Ok(())
}

#[test]
fn rejects_unsafe_probe_shapes() -> Result<(), Box<dyn std::error::Error>> {
    let metadata = ContainerMetadata {
        format: "mp4".into(),
        duration_ticks: 0,
        timebase: Timebase::new(1, 1_000)?,
        streams: vec![StreamMetadata::fixture(
            0,
            false,
            MetadataLimits::default().max_dimension + 1,
            10,
        )],
    };
    assert!(matches!(
        ContainerMetadata::parse(&serde_json::to_vec(&metadata)?, &MetadataLimits::default()),
        Err(VideoError::InvalidProbe(_))
    ));
    assert_eq!(
        ContainerMetadata::parse(
            &vec![b' '; MetadataLimits::default().max_probe_bytes + 1],
            &MetadataLimits::default()
        ),
        Err(VideoError::ProbeTooLarge)
    );
    Ok(())
}

#[test]
fn creates_gpu_aligned_multiplane_layouts() -> Result<(), Box<dyn std::error::Error>> {
    let frame = GpuFrameDescriptor::aligned(
        1920,
        1080,
        GpuPixelFormat::Nv12,
        ColorMetadata::default(),
        &MetadataLimits::default(),
    )?;
    assert_eq!(frame.planes.len(), 2);
    assert!(
        frame
            .planes
            .iter()
            .all(|plane| plane.bytes_per_row % 256 == 0)
    );
    assert_eq!(
        frame.planes[1].offset,
        u64::from(frame.planes[0].bytes_per_row) * 1080
    );
    assert!(
        GpuFrameDescriptor::aligned(
            1919,
            1080,
            GpuPixelFormat::Nv12,
            ColorMetadata::default(),
            &MetadataLimits::default()
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn packet_cache_is_bounded_and_lru() -> Result<(), Box<dyn std::error::Error>> {
    let mut cache = PacketCache::new(8);
    let make = |value| Packet {
        presentation_timestamp: value,
        duration: 1,
        keyframe: false,
        bytes: Arc::from([value as u8; 4]),
    };
    let first = PacketKey {
        stream_index: 0,
        decode_timestamp: 1,
    };
    let second = PacketKey {
        stream_index: 0,
        decode_timestamp: 2,
    };
    let third = PacketKey {
        stream_index: 0,
        decode_timestamp: 3,
    };
    assert!(cache.insert(first, make(1)));
    assert!(cache.insert(second, make(2)));
    assert!(cache.get(&first).is_some());
    assert!(cache.insert(third, make(3)));
    assert!(cache.get(&second).is_none());
    assert_eq!(cache.statistics().evictions, 1);
    assert_eq!(cache.statistics().bytes, 8);
    Ok(())
}

#[test]
fn frame_cache_rejects_oversized_values_without_eviction() -> Result<(), Box<dyn std::error::Error>>
{
    let descriptor = GpuFrameDescriptor::aligned(
        2,
        2,
        GpuPixelFormat::Rgba8,
        ColorMetadata::default(),
        &MetadataLimits::default(),
    )?;
    let mut cache = FrameCache::new(4);
    let frame = DecodedFrame {
        descriptor,
        duration: 1,
        bytes: Arc::from([0_u8; 8]),
    };
    assert!(!cache.insert(
        FrameKey {
            stream_index: 0,
            presentation_timestamp: 0
        },
        frame
    ));
    assert_eq!(cache.statistics().entries, 0);
    Ok(())
}

#[test]
fn invalid_timebases_cannot_reach_division() -> Result<(), Box<dyn std::error::Error>> {
    let valid = Timebase::new(1, 1)?;
    for invalid in [
        Timebase {
            numerator: 0,
            denominator: 1,
        },
        Timebase {
            numerator: 1,
            denominator: 0,
        },
    ] {
        assert_eq!(valid.rescale(1, invalid), Err(VideoError::InvalidTimebase));
        assert_eq!(invalid.rescale(1, valid), Err(VideoError::InvalidTimebase));
        assert_eq!(invalid.seconds(1), Err(VideoError::InvalidTimebase));
        assert!(serde_json::from_slice::<Timebase>(&serde_json::to_vec(&invalid)?).is_err());
    }
    Ok(())
}
