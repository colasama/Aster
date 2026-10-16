use aster_render_ir::{OwnedFpln, ResourceRegistry};

use super::Worker;
use crate::{native_stills::NativeStillResources, native_textures::NativeTextureResources};

/// Per-request decoded CPU resources; device caches retain their own uploaded generations.
pub(super) struct FrameInputs {
    pub(super) media: NativeStillResources,
    pub(super) textures: NativeTextureResources,
}

impl FrameInputs {
    pub(super) fn install(
        worker: &mut Worker,
        plan: &OwnedFpln,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let mut textures =
            NativeTextureResources::install(worker.textures.as_mut(), plan, &mut worker.registry)?;
        match NativeStillResources::install(
            worker.media.as_mut(),
            plan,
            &mut worker.registry,
            &worker.limits,
        ) {
            Ok(media) => Ok(Self { media, textures }),
            Err(error) => {
                textures.release(&mut worker.registry)?;
                Err(error)
            }
        }
    }

    pub(super) fn release(
        &mut self,
        registry: &mut ResourceRegistry,
    ) -> Result<(), aster_render_ir::IrError> {
        let media = self.media.release(registry);
        let textures = self.textures.release(registry);
        media?;
        textures
    }
}
