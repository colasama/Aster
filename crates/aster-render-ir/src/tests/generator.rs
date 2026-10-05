use super::Fixture;
use crate::{
    CompositionIdentity, ContractLevel, DecodeLimits, EffectBlendMode, ElementType, FplnCodec,
    GeneratorBlend, GeneratorCompute, GeneratorCull, GeneratorDepth, GeneratorGraph,
    GeneratorPhase, GeneratorProgram, GeneratorVariant, IrError, PlanSlice, ResourceHash,
    SceneGeneratorSlice,
};
#[test]
fn generator_payload_roundtrip_and_inconsistent_execution_rejection() -> Result<(), IrError> {
    let mut metadata = Fixture::new()?.metadata;
    metadata.contract_level = ContractLevel::SceneGeneratorSliceV1;
    let shader = ResourceHash("a".repeat(64));
    metadata.resources = vec![shader.clone()];
    metadata.blobs.truncate(1);
    metadata.blobs[0].byte_offset = 0;
    metadata.blobs[0].byte_length = 11552;
    metadata.blobs[0].element_count = 11552;
    metadata.blobs[0].element_type = ElementType::U8;
    metadata.slices = vec![PlanSlice::SceneGenerator(SceneGeneratorSlice {
        blob_index: 0,
        instance_id: CompositionIdentity::Unicode("instance".to_owned()),
        selection_id: CompositionIdentity::Unicode("selection".to_owned()),
        blend_mode: EffectBlendMode::Screen,
        program: GeneratorProgram {
            source_key: CompositionIdentity::Unicode("program".to_owned()),
            label: CompositionIdentity::Unicode("Generator".to_owned()),
            audio_analysis: true,
            graph: GeneratorGraph {
                api_version: 1,
                max_instances: 4096,
                instance_stride: 16,
                compute_passes: vec![GeneratorCompute {
                    id: "compute".to_owned(),
                    shader: shader.clone(),
                    entry_point: "main".to_owned(),
                    workgroup_size: [64, 1, 1],
                    phase: GeneratorPhase::Simulation,
                }],
                render_variants: vec![GeneratorVariant {
                    id: "quad".to_owned(),
                    shader,
                    vertex_entry: "vertex".to_owned(),
                    fragment_entry: "fragment".to_owned(),
                    vertex_count: 6,
                    blend: GeneratorBlend::Layer,
                    depth: GeneratorDepth::ReadWrite,
                    cull: GeneratorCull::None,
                    auxiliary: None,
                }],
            },
        },
        variant_index: 0,
        requested_count: 1500,
        effective_count: 1024,
        capacity: 1024,
        dispatches: vec![[16, 1, 1]],
        has_audio: true,
    })];
    let mut bytes = vec![0_u8; 11552];
    bytes[24..28].copy_from_slice(&1024_u32.to_le_bytes());
    bytes[2256..2260].copy_from_slice(&6_u32.to_le_bytes());
    for (offset, bits) in [(208, 0x8000_0000_u32), (212, 1), (2272, 0x7fc0_1234)] {
        bytes[offset..offset + 4].copy_from_slice(&bits.to_le_bytes());
    }
    let limits = DecodeLimits::default();
    let encoded = FplnCodec::encode(metadata.clone(), &[&bytes], &limits)?;
    let decoded = FplnCodec::decode(encoded.clone(), &limits)?;
    assert_eq!(decoded.blob(0)?, bytes);
    assert_eq!(decoded.reencode(&limits)?, encoded);
    for mode in [
        "dispatch",
        "capacity",
        "workgroup",
        "variant",
        "resources",
        "audio",
        "identifier",
    ] {
        let mut broken = metadata.clone();
        if let PlanSlice::SceneGenerator(g) = &mut broken.slices[0] {
            match mode {
                "dispatch" => g.dispatches[0][0] += 1,
                "capacity" => g.capacity = 100,
                "workgroup" => g.program.graph.compute_passes[0].workgroup_size[0] = 0,
                "variant" => g.variant_index = 8,
                "audio" => g.program.audio_analysis = false,
                "identifier" => {
                    g.program.graph.render_variants[0].vertex_entry = "bad-name".to_owned()
                }
                _ => broken.resources.clear(),
            }
        }
        assert!(broken.validate(&limits).is_err(), "{mode}");
    }
    bytes[24] ^= 1;
    assert!(FplnCodec::encode(metadata, &[&bytes], &limits).is_err());
    Ok(())
}
