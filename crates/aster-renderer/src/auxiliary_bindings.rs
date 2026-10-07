use crate::{AuxiliaryPrimaryPlan, RenderError};
use aster_render_ir::RootTextureReference;

impl AuxiliaryPrimaryPlan {
    pub(crate) fn bindings(
        &self,
        frame: &crate::SuppliedFrame,
        caches: (
            &crate::image_cache::ImageCache,
            &crate::surface_cache::SurfaceCache,
        ),
    ) -> Result<Vec<Option<wgpu::BindGroup>>, RenderError> {
        self.draws
            .iter()
            .map(|draw| match &draw.texture {
                RootTextureReference::None => Ok(None),
                RootTextureReference::Media { hash } => {
                    // Scene generations include GPU-derived temporal outputs, unlike upload inputs.
                    let image = frame
                        .scene
                        .images
                        .get(hash)
                        .ok_or_else(|| RenderError::Invalid("auxiliary image absent".into()))?;
                    Ok(Some(caches.0.binding(image)?.clone()))
                }
                RootTextureReference::Surface { instance_id } => Ok(Some(
                    caches.1.binding(&frame.surfaces, instance_id)?.clone(),
                )),
                _ => Err(RenderError::Unsupported("auxiliary texture".into())),
            })
            .collect()
    }
    pub(crate) fn validate_resources(
        &self,
        scene: &crate::scene_input::SceneInput,
        surfaces: &crate::surface_plan::SurfacePlan,
    ) -> Result<(), RenderError> {
        for draw in &self.draws {
            if !scene.root.draws.iter().any(|root| {
                root.instance_id == draw.instance_id
                    && root.first_vertex == draw.first_vertex
                    && root.vertex_count == draw.vertex_count
                    && root.texture == draw.texture
            }) {
                return Err(RenderError::Invalid(
                    "auxiliary draw differs from root geometry".into(),
                ));
            }
            match &draw.texture {
                RootTextureReference::None => {}
                RootTextureReference::Media { hash } if scene.images.contains_key(hash) => {}
                RootTextureReference::Surface { instance_id }
                    if surfaces
                        .bindings
                        .contains_key(&crate::surface_plan::SurfacePlan::key(instance_id)) => {}
                _ => {
                    return Err(RenderError::Invalid(
                        "auxiliary image or surface binding missing".into(),
                    ));
                }
            }
        }
        Ok(())
    }
}
