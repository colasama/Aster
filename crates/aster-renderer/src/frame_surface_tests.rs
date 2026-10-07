use aster_render_ir::{
    BufferResourceDescriptor, DecodeLimits, ElementType, FinalOutputRoute, FinalSurfaceMode,
    FplnCodec, OwnedFpln, PlanSlice, PostEffectStatus, PutResource, ResourceDescriptor,
    ResourceHash, ResourceKind, ResourceRegistry,
};

use crate::SuppliedFrame;

struct FrameFixture {
    plan: OwnedFpln,
    registry: ResourceRegistry,
}

impl FrameFixture {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let base = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/parity/native-surface-frame");
        let plan = FplnCodec::decode(
            std::fs::read(base.join("selectionIsolation-off-ready/plan.fpln"))?,
            &DecodeLimits::default(),
        )?;
        let mut registry = ResourceRegistry::new(Default::default())?;
        for hash in &plan.metadata.resources {
            let bytes = std::fs::read(base.join(format!("resources/{}.bin", hash.0)))?;
            registry.put(
                PutResource {
                    hash: hash.clone(),
                    kind: ResourceKind::Buffer,
                    descriptor: ResourceDescriptor::Buffer(BufferResourceDescriptor {
                        element_type: ElementType::U8,
                        element_count: bytes.len() as u32,
                        byte_length: bytes.len() as u32,
                    }),
                },
                bytes,
            )?;
        }
        Ok(Self { plan, registry })
    }

    fn change(
        &mut self,
        stage: &str,
        change: impl FnOnce(&mut OwnedFpln),
    ) -> Result<(), Box<dyn std::error::Error>> {
        let Some(PlanSlice::FrameBundle(bundle)) = self.plan.metadata.slices.first() else {
            return Err("bundle missing".into());
        };
        let hash = match stage {
            "output" => Some(&bundle.output),
            "auxiliary" => bundle.auxiliary.as_ref(),
            "effect" => bundle.effect.as_ref(),
            _ => None,
        }
        .ok_or("stage missing")?
        .clone();
        let mut plan = FplnCodec::decode(
            self.registry.resolve(&hash)?.to_vec(),
            &DecodeLimits::default(),
        )?;
        change(&mut plan);
        let bytes = plan.reencode(&DecodeLimits::default())?;
        let descriptor = BufferResourceDescriptor {
            element_type: ElementType::U8,
            element_count: bytes.len() as u32,
            byte_length: bytes.len() as u32,
        };
        let next = ResourceHash::for_buffer(&descriptor, &bytes)?;
        self.registry.put(
            PutResource {
                hash: next.clone(),
                kind: ResourceKind::Buffer,
                descriptor: ResourceDescriptor::Buffer(descriptor),
            },
            bytes,
        )?;
        let Some(PlanSlice::FrameBundle(bundle)) = self.plan.metadata.slices.first_mut() else {
            return Err("bundle missing".into());
        };
        match stage {
            "output" => bundle.output = next.clone(),
            "auxiliary" => bundle.auxiliary = Some(next.clone()),
            "effect" => bundle.effect = Some(next.clone()),
            _ => return Err("stage missing".into()),
        }
        self.plan.metadata.resources.retain(|old| old != &hash);
        self.plan.metadata.resources.push(next);
        self.plan.metadata.resources.sort();
        self.plan.metadata.resources.dedup();
        Ok(())
    }

    fn admit(self, expected_error: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
        let result = SuppliedFrame::new(self.plan, &self.registry, &DecodeLimits::default(), &[]);
        if let Some(expected) = expected_error {
            let error = result.err().ok_or("incorrectly admitted frame")?;
            assert!(error.to_string().contains(expected), "{error}");
        } else {
            assert!(result.is_ok());
        }
        Ok(())
    }

    fn remove_auxiliary(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        let Some(PlanSlice::FrameBundle(bundle)) = self.plan.metadata.slices.first_mut() else {
            return Err("bundle missing".into());
        };
        let old = bundle.auxiliary.take().ok_or("auxiliary absent")?;
        self.plan.metadata.resources.retain(|hash| hash != &old);
        Ok(())
    }
}

#[test]
fn supplied_surface_routes_reject_inconsistent_stages_before_gpu_work()
-> Result<(), Box<dyn std::error::Error>> {
    FrameFixture::new()?.admit(None)?;
    let mut fixture = FrameFixture::new()?;
    fixture.change("output", |plan| {
        if let Some(PlanSlice::FinalOutput(output)) = plan.metadata.slices.first_mut() {
            output.route = FinalOutputRoute::Surface {
                mode: FinalSurfaceMode::VectorMotionBlur,
            };
        }
    })?;
    fixture.admit(Some("mode differs"))?;
    let mut fixture = FrameFixture::new()?;
    fixture.remove_auxiliary()?;
    fixture.admit(Some("requires auxiliary"))?;
    let mut fixture = FrameFixture::new()?;
    fixture.change("auxiliary", |plan| {
        plan.metadata.header.project_revision += 1;
    })?;
    fixture.admit(Some("frame identity mismatch"))?;
    let mut fixture = FrameFixture::new()?;
    fixture.change("auxiliary", |plan| {
        if let Some(PlanSlice::Auxiliary(slice)) = plan.metadata.slices.first_mut() {
            slice.draws[0].vertex_count -= 3;
        }
    })?;
    fixture.admit(Some("draw differs"))?;
    let mut fixture = FrameFixture::new()?;
    fixture.change("effect", |plan| {
        if let Some(PlanSlice::PostEffect(slice)) = plan.metadata.slices.first_mut() {
            slice.status = PostEffectStatus::Skipped;
        }
    })?;
    fixture.remove_auxiliary()?;
    fixture.admit(None)?;
    Ok(())
}
