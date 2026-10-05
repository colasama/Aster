use super::Fixture;
use crate::{
    CompositionIdentity, ContractLevel, DecodeLimits, EffectBlendMode, ElementType, FplnCodec,
    IrError, PlanSlice, RootCommandRecord, RootDrawRecord, RootLoadOp, RootPassGroup,
    RootSceneCommandsSlice, RootStoreOp, RootTextureReference,
};

#[test]
fn root_commands_preserve_clear_bits_and_reject_invalid_execution() -> Result<(), IrError> {
    let mut metadata = Fixture::new()?.metadata;
    metadata.contract_level = ContractLevel::RootSceneCommandsSliceV1;
    metadata.resources.clear();
    metadata.blobs.truncate(1);
    metadata.blobs[0].element_type = ElementType::U8;
    metadata.blobs[0].byte_length = 40;
    metadata.blobs[0].element_count = 40;
    metadata.slices = vec![PlanSlice::RootSceneCommands(RootSceneCommandsSlice {
        blob_index: 0,
        draws: vec![RootDrawRecord {
            instance_id: CompositionIdentity::Unicode("draw".to_owned()),
            first_vertex: 3,
            vertex_count: 6,
            blend_mode: EffectBlendMode::Screen,
            texture: RootTextureReference::Pending,
            material_blob_index: None,
        }],
        commands: vec![
            RootCommandRecord::BeginScene {
                group: RootPassGroup::Composition,
                color_load: RootLoadOp::Clear,
                color_store: RootStoreOp::Store,
                depth_load: RootLoadOp::Clear,
                depth_store: RootStoreOp::Store,
                clear_index: 0,
            },
            RootCommandRecord::Geometry {
                draw_index: 0,
                blend_mode: EffectBlendMode::Screen,
            },
            RootCommandRecord::EndScene,
        ],
    })];
    let bytes: Vec<u8> = [-0.0, f64::from_bits(1), 1.0 / 3.0, 1.0, 1.0]
        .into_iter()
        .flat_map(f64::to_le_bytes)
        .collect();
    let limits = DecodeLimits::default();
    let encoded = FplnCodec::encode(metadata.clone(), &[&bytes], &limits)?;
    assert_eq!(
        FplnCodec::decode(encoded.clone(), &limits)?.reencode(&limits)?,
        encoded
    );
    let mut invalid = bytes.clone();
    invalid[0..8].copy_from_slice(&f64::NAN.to_le_bytes());
    assert!(matches!(
        FplnCodec::encode(metadata.clone(), &[&invalid], &limits),
        Err(IrError::InvalidRootScene(_))
    ));
    for mode in ["open", "draw", "material", "blend", "first"] {
        let mut broken = metadata.clone();
        if let PlanSlice::RootSceneCommands(root) = &mut broken.slices[0] {
            match mode {
                "open" => {
                    root.commands.pop();
                }
                "draw" => {
                    root.commands[1] = RootCommandRecord::Geometry {
                        draw_index: 1,
                        blend_mode: EffectBlendMode::Screen,
                    }
                }
                "material" => root.draws[0].material_blob_index = Some(0),
                "blend" => {
                    root.commands[1] = RootCommandRecord::Geometry {
                        draw_index: 0,
                        blend_mode: EffectBlendMode::Multiply,
                    }
                }
                _ => {
                    root.commands.remove(0);
                }
            }
        }
        assert!(broken.validate(&limits).is_err(), "{mode}");
    }
    Ok(())
}
