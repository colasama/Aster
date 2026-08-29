//! Unified 2D and 3D scene representation.

use std::collections::HashSet;

use glam::{EulerRot, Mat4, Quat, Vec3};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Scene {
    entities: IndexMap<Uuid, Entity>,
}

impl Scene {
    pub fn insert(&mut self, entity: Entity) -> Result<(), SceneError> {
        if self.entities.contains_key(&entity.id) {
            return Err(SceneError::DuplicateEntity(entity.id));
        }
        if let Some(parent) = entity.parent
            && !self.entities.contains_key(&parent)
        {
            return Err(SceneError::MissingEntity(parent));
        }
        self.entities.insert(entity.id, entity);
        Ok(())
    }

    pub fn set_parent(&mut self, entity: Uuid, parent: Option<Uuid>) -> Result<(), SceneError> {
        if !self.entities.contains_key(&entity) {
            return Err(SceneError::MissingEntity(entity));
        }
        if let Some(parent_id) = parent {
            if !self.entities.contains_key(&parent_id) {
                return Err(SceneError::MissingEntity(parent_id));
            }
            let mut cursor = Some(parent_id);
            while let Some(id) = cursor {
                if id == entity {
                    return Err(SceneError::ParentCycle);
                }
                cursor = self.entities.get(&id).and_then(|item| item.parent);
            }
        }
        self.entities
            .get_mut(&entity)
            .expect("validated entity")
            .parent = parent;
        Ok(())
    }

    pub fn world_matrices(&self) -> Result<IndexMap<Uuid, Mat4>, SceneError> {
        let mut matrices = IndexMap::with_capacity(self.entities.len());
        let mut visiting = HashSet::new();
        for id in self.entities.keys().copied() {
            self.evaluate_world(id, &mut matrices, &mut visiting)?;
        }
        Ok(matrices)
    }

    fn evaluate_world(
        &self,
        id: Uuid,
        cache: &mut IndexMap<Uuid, Mat4>,
        visiting: &mut HashSet<Uuid>,
    ) -> Result<Mat4, SceneError> {
        if let Some(matrix) = cache.get(&id) {
            return Ok(*matrix);
        }
        if !visiting.insert(id) {
            return Err(SceneError::ParentCycle);
        }
        let entity = self
            .entities
            .get(&id)
            .ok_or(SceneError::MissingEntity(id))?;
        let local = entity.transform.matrix();
        let world = if let Some(parent) = entity.parent {
            self.evaluate_world(parent, cache, visiting)? * local
        } else {
            local
        };
        visiting.remove(&id);
        cache.insert(id, world);
        Ok(world)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Entity {
    pub id: Uuid,
    pub name: String,
    pub parent: Option<Uuid>,
    pub transform: Transform3d,
    pub renderable: Renderable,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Transform3d {
    pub position: [f32; 3],
    pub rotation_degrees: [f32; 3],
    pub scale: [f32; 3],
}

impl Transform3d {
    pub fn matrix(self) -> Mat4 {
        Mat4::from_scale_rotation_translation(
            Vec3::from_array(self.scale),
            Quat::from_euler(
                EulerRot::XYZ,
                self.rotation_degrees[0].to_radians(),
                self.rotation_degrees[1].to_radians(),
                self.rotation_degrees[2].to_radians(),
            ),
            Vec3::from_array(self.position),
        )
    }
}

impl Default for Transform3d {
    fn default() -> Self {
        Self {
            position: [0.0; 3],
            rotation_degrees: [0.0; 3],
            scale: [1.0; 3],
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Renderable {
    Plane2d {
        size: [f32; 2],
    },
    Mesh {
        asset: Uuid,
        material: Uuid,
    },
    Camera(Camera),
    Light(Light),
    Generator {
        plugin_id: String,
        node_type: String,
        api_version: u32,
    },
    None,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Camera {
    pub projection: Projection,
    pub near: f32,
    pub far: f32,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Projection {
    Perspective { vertical_fov_degrees: f32 },
    Orthographic { height: f32 },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Light {
    pub kind: LightKind,
    pub color: [f32; 3],
    pub intensity: f32,
    pub casts_shadow: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LightKind {
    Directional,
    Point,
    Spot,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuxiliaryBuffer {
    Color,
    Depth,
    Normal,
    MotionVector,
    ObjectId,
    MaterialId,
    WorldPosition,
}

#[derive(Clone, Copy, Debug, Error, PartialEq)]
pub enum SceneError {
    #[error("entity {0} does not exist")]
    MissingEntity(Uuid),
    #[error("entity {0} already exists")]
    DuplicateEntity(Uuid),
    #[error("parenting would create a cycle")]
    ParentCycle,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entity(id: Uuid, parent: Option<Uuid>, x: f32) -> Entity {
        Entity {
            id,
            name: "entity".into(),
            parent,
            transform: Transform3d {
                position: [x, 0.0, 0.0],
                ..Transform3d::default()
            },
            renderable: Renderable::None,
        }
    }

    #[test]
    fn evaluates_parented_world_transform() {
        let parent = Uuid::new_v4();
        let child = Uuid::new_v4();
        let mut scene = Scene::default();
        scene.insert(entity(parent, None, 4.0)).unwrap();
        scene.insert(entity(child, Some(parent), 2.0)).unwrap();
        let matrices = scene.world_matrices().unwrap();
        assert_eq!(matrices[&child].transform_point3(Vec3::ZERO).x, 6.0);
    }

    #[test]
    fn rejects_parent_cycles() {
        let parent = Uuid::new_v4();
        let child = Uuid::new_v4();
        let mut scene = Scene::default();
        scene.insert(entity(parent, None, 0.0)).unwrap();
        scene.insert(entity(child, Some(parent), 0.0)).unwrap();
        assert_eq!(
            scene.set_parent(parent, Some(child)),
            Err(SceneError::ParentCycle)
        );
    }
}
