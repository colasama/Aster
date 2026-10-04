use crate::{
    AntiAliasing, BlobDescriptor, BufferResourceDescriptor, ColorPipeline, CompositionIdentity,
    ContractLevel, DecodeLimits, ElementType, Extent2d, FplnCodec, FrameHeaderSlice,
    FramePlanSliceV1, FrameRate, FrameTime, IrError, PlanKind, PlanSlice, ResourceHash,
};

/// Independently generated numeric payloads exercise the wire format without a GPU or TS source.
pub struct IrFixture;

impl IrFixture {
    pub fn parts() -> Result<(FramePlanSliceV1, Vec<Vec<u8>>), IrError> {
        let mut lanes: [f32; 24] = [
            640.0,
            360.0,
            -1001.0 / 24000.0,
            -0.0,
            1.0,
            1.0,
            0.0,
            0.0,
            0.0,
            0.8,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.18,
            0.0,
            1.0,
            0.0,
        ];
        let first = lanes.iter().flat_map(|value| value.to_le_bytes()).collect();
        lanes[3] = f32::from_bits(0x3f80_0001);
        let second = lanes.iter().flat_map(|value| value.to_le_bytes()).collect();
        let blobs = vec![first, second];
        let metadata = FramePlanSliceV1 {
            kind: PlanKind::FramePlanSlice,
            plan_version: 1,
            contract_level: ContractLevel::PostUniformsSliceV1,
            renderer_plan_complete: false,
            header: FrameHeaderSlice {
                snapshot_scope: "rust-independent-fixture".to_owned(),
                project_revision: 9_007_199_254_740_991,
                composition_id: CompositionIdentity::Unicode("Rust fixture · 空 ☄".to_owned()),
                time: FrameTime::Rational {
                    value: -1001,
                    scale: 24000,
                },
                frame_rate: FrameRate::Rational {
                    numerator: 24000,
                    denominator: 1001,
                },
                target: Extent2d {
                    width: 640,
                    height: 360,
                },
                render_target: Extent2d {
                    width: 640,
                    height: 360,
                },
                aa: AntiAliasing::Off,
                color_pipeline: ColorPipeline::LinearHdrToSrgbDisplay,
            },
            blobs: (0..2)
                .map(|index| BlobDescriptor {
                    byte_offset: index * 96,
                    byte_length: 96,
                    element_type: ElementType::F32Le,
                    element_count: 24,
                })
                .collect(),
            slices: (0..2)
                .map(|blob_index| PlanSlice::PostProcessUniforms { blob_index })
                .collect(),
            resources: vec![ResourceHash::for_buffer(
                &BufferResourceDescriptor {
                    element_type: ElementType::U8,
                    element_count: 4,
                    byte_length: 4,
                },
                &[1, 2, 3, 4],
            )?],
        };
        Ok((metadata, blobs))
    }

    pub fn encode(limits: &DecodeLimits) -> Result<Vec<u8>, IrError> {
        let (metadata, blobs) = Self::parts()?;
        let borrowed = blobs.iter().map(Vec::as_slice).collect::<Vec<_>>();
        FplnCodec::encode(metadata, &borrowed, limits)
    }
}
