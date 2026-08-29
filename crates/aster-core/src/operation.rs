use aster_timeline::{Animatable, Keyframe};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{Composition, Layer, Project, Transform};

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyKey {
    PositionX,
    PositionY,
    PositionZ,
    RotationX,
    RotationY,
    RotationZ,
    ScaleX,
    ScaleY,
    ScaleZ,
    AnchorX,
    AnchorY,
    AnchorZ,
    Opacity,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Operation {
    AddComposition {
        composition: Box<Composition>,
    },
    RemoveComposition {
        composition_id: Uuid,
    },
    AddLayer {
        composition_id: Uuid,
        layer: Box<Layer>,
    },
    RemoveLayer {
        composition_id: Uuid,
        layer_id: Uuid,
    },
    RenameLayer {
        composition_id: Uuid,
        layer_id: Uuid,
        name: String,
    },
    SetProperty {
        composition_id: Uuid,
        layer_id: Uuid,
        property: PropertyKey,
        value: f64,
    },
    AddKeyframe {
        composition_id: Uuid,
        layer_id: Uuid,
        property: PropertyKey,
        keyframe: Keyframe,
    },
    RestoreProperty {
        composition_id: Uuid,
        layer_id: Uuid,
        property: PropertyKey,
        value: Animatable,
    },
}

impl Operation {
    pub fn apply(&self, project: &mut Project) -> Result<Self, OperationError> {
        match self {
            Self::AddComposition { composition } => {
                if project.composition(composition.id).is_some() {
                    return Err(OperationError::DuplicateId(composition.id));
                }
                project.compositions.push(composition.as_ref().clone());
                Ok(Self::RemoveComposition {
                    composition_id: composition.id,
                })
            }
            Self::RemoveComposition { composition_id } => {
                let index = project
                    .compositions
                    .iter()
                    .position(|composition| composition.id == *composition_id)
                    .ok_or(OperationError::CompositionNotFound(*composition_id))?;
                if project.compositions.len() == 1 {
                    return Err(OperationError::CannotRemoveLastComposition);
                }
                let composition = project.compositions.remove(index);
                if project.active_composition == *composition_id {
                    project.active_composition = project.compositions[0].id;
                }
                Ok(Self::AddComposition {
                    composition: Box::new(composition),
                })
            }
            Self::AddLayer {
                composition_id,
                layer,
            } => {
                let composition = composition_mut(project, *composition_id)?;
                if composition.layer(layer.id).is_some() {
                    return Err(OperationError::DuplicateId(layer.id));
                }
                composition.layers.push(layer.as_ref().clone());
                Ok(Self::RemoveLayer {
                    composition_id: *composition_id,
                    layer_id: layer.id,
                })
            }
            Self::RemoveLayer {
                composition_id,
                layer_id,
            } => {
                let composition = composition_mut(project, *composition_id)?;
                let index = composition
                    .layers
                    .iter()
                    .position(|layer| layer.id == *layer_id)
                    .ok_or(OperationError::LayerNotFound(*layer_id))?;
                let layer = composition.layers.remove(index);
                for child in &mut composition.layers {
                    if child.parent == Some(*layer_id) {
                        child.parent = None;
                    }
                }
                Ok(Self::AddLayer {
                    composition_id: *composition_id,
                    layer: Box::new(layer),
                })
            }
            Self::RenameLayer {
                composition_id,
                layer_id,
                name,
            } => {
                let layer = layer_mut(project, *composition_id, *layer_id)?;
                let previous = std::mem::replace(&mut layer.name, name.clone());
                Ok(Self::RenameLayer {
                    composition_id: *composition_id,
                    layer_id: *layer_id,
                    name: previous,
                })
            }
            Self::SetProperty {
                composition_id,
                layer_id,
                property,
                value,
            } => {
                let layer = layer_mut(project, *composition_id, *layer_id)?;
                let slot = property_mut(&mut layer.transform, *property);
                let previous = slot.clone();
                *slot = Animatable::constant(*value);
                Ok(Self::RestoreProperty {
                    composition_id: *composition_id,
                    layer_id: *layer_id,
                    property: *property,
                    value: previous,
                })
            }
            Self::AddKeyframe {
                composition_id,
                layer_id,
                property,
                keyframe,
            } => {
                let layer = layer_mut(project, *composition_id, *layer_id)?;
                let slot = property_mut(&mut layer.transform, *property);
                let previous = slot.clone();
                slot.insert(keyframe.clone());
                Ok(Self::RestoreProperty {
                    composition_id: *composition_id,
                    layer_id: *layer_id,
                    property: *property,
                    value: previous,
                })
            }
            Self::RestoreProperty {
                composition_id,
                layer_id,
                property,
                value,
            } => {
                let layer = layer_mut(project, *composition_id, *layer_id)?;
                let slot = property_mut(&mut layer.transform, *property);
                let previous = std::mem::replace(slot, value.clone());
                Ok(Self::RestoreProperty {
                    composition_id: *composition_id,
                    layer_id: *layer_id,
                    property: *property,
                    value: previous,
                })
            }
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct OperationHistory {
    undo: Vec<HistoryEntry>,
    redo: Vec<HistoryEntry>,
}

impl OperationHistory {
    pub fn execute(
        &mut self,
        project: &mut Project,
        operations: Vec<Operation>,
    ) -> Result<(), OperationError> {
        let mut inverses = Vec::with_capacity(operations.len());
        for operation in &operations {
            match operation.apply(project) {
                Ok(inverse) => inverses.push(inverse),
                Err(error) => {
                    for inverse in inverses.iter().rev() {
                        inverse.apply(project)?;
                    }
                    return Err(error);
                }
            }
        }
        inverses.reverse();
        self.undo.push(HistoryEntry {
            forward: operations,
            inverse: inverses,
        });
        self.redo.clear();
        Ok(())
    }

    pub fn undo(&mut self, project: &mut Project) -> Result<bool, OperationError> {
        let Some(entry) = self.undo.pop() else {
            return Ok(false);
        };
        apply_all(project, &entry.inverse)?;
        self.redo.push(entry);
        Ok(true)
    }

    pub fn redo(&mut self, project: &mut Project) -> Result<bool, OperationError> {
        let Some(entry) = self.redo.pop() else {
            return Ok(false);
        };
        apply_all(project, &entry.forward)?;
        self.undo.push(entry);
        Ok(true)
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
}

#[derive(Clone, Debug)]
struct HistoryEntry {
    forward: Vec<Operation>,
    inverse: Vec<Operation>,
}

fn apply_all(project: &mut Project, operations: &[Operation]) -> Result<(), OperationError> {
    for operation in operations {
        operation.apply(project)?;
    }
    Ok(())
}

fn composition_mut(project: &mut Project, id: Uuid) -> Result<&mut Composition, OperationError> {
    project
        .composition_mut(id)
        .ok_or(OperationError::CompositionNotFound(id))
}

fn layer_mut(
    project: &mut Project,
    composition_id: Uuid,
    layer_id: Uuid,
) -> Result<&mut Layer, OperationError> {
    composition_mut(project, composition_id)?
        .layer_mut(layer_id)
        .ok_or(OperationError::LayerNotFound(layer_id))
}

fn property_mut(transform: &mut Transform, property: PropertyKey) -> &mut Animatable {
    match property {
        PropertyKey::PositionX => &mut transform.position_x,
        PropertyKey::PositionY => &mut transform.position_y,
        PropertyKey::PositionZ => &mut transform.position_z,
        PropertyKey::RotationX => &mut transform.rotation_x,
        PropertyKey::RotationY => &mut transform.rotation_y,
        PropertyKey::RotationZ => &mut transform.rotation_z,
        PropertyKey::ScaleX => &mut transform.scale_x,
        PropertyKey::ScaleY => &mut transform.scale_y,
        PropertyKey::ScaleZ => &mut transform.scale_z,
        PropertyKey::AnchorX => &mut transform.anchor_x,
        PropertyKey::AnchorY => &mut transform.anchor_y,
        PropertyKey::AnchorZ => &mut transform.anchor_z,
        PropertyKey::Opacity => &mut transform.opacity,
    }
}

#[derive(Clone, Debug, Error, PartialEq)]
pub enum OperationError {
    #[error("composition {0} does not exist")]
    CompositionNotFound(Uuid),
    #[error("layer {0} does not exist")]
    LayerNotFound(Uuid),
    #[error("object {0} already exists")]
    DuplicateId(Uuid),
    #[error("a project must contain at least one composition")]
    CannotRemoveLastComposition,
}

#[cfg(test)]
mod tests {
    use aster_timeline::{FrameRate, Time};

    use super::*;
    use crate::{BlendMode, LayerKind};

    fn project() -> Project {
        let composition_id = Uuid::new_v4();
        Project {
            schema_version: Project::SCHEMA_VERSION,
            id: Uuid::new_v4(),
            name: "Test".into(),
            active_composition: composition_id,
            compositions: vec![Composition {
                id: composition_id,
                name: "Main".into(),
                width: 3840,
                height: 2160,
                frame_rate: FrameRate::default(),
                duration: Time::new(10, 1).unwrap(),
                background: [0.0, 0.0, 0.0, 1.0],
                layers: Vec::new(),
            }],
        }
    }

    fn layer() -> Layer {
        Layer {
            id: Uuid::new_v4(),
            name: "Title".into(),
            kind: LayerKind::Text {
                text: "Aster".into(),
            },
            parent: None,
            visible: true,
            solo: false,
            locked: false,
            in_point: Time::ZERO,
            out_point: Time::new(10, 1).unwrap(),
            blend_mode: BlendMode::Normal,
            transform: Transform::default(),
            effects: Vec::new(),
        }
    }

    #[test]
    fn transaction_undo_and_redo_are_deterministic() {
        let mut project = project();
        let composition_id = project.active_composition;
        let layer = layer();
        let mut history = OperationHistory::default();
        history
            .execute(
                &mut project,
                vec![Operation::AddLayer {
                    composition_id,
                    layer: Box::new(layer.clone()),
                }],
            )
            .unwrap();
        assert_eq!(project.compositions[0].layers.len(), 1);
        history.undo(&mut project).unwrap();
        assert!(project.compositions[0].layers.is_empty());
        history.redo(&mut project).unwrap();
        assert_eq!(project.compositions[0].layers[0].id, layer.id);
    }
}
