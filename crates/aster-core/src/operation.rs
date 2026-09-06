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
                let composition = project
                    .composition_mut(*composition_id)
                    .ok_or(OperationError::CompositionNotFound(*composition_id))?;
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
                let composition = project
                    .composition_mut(*composition_id)
                    .ok_or(OperationError::CompositionNotFound(*composition_id))?;
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
                let layer = project.operation_layer_mut(*composition_id, *layer_id)?;
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
                let layer = project.operation_layer_mut(*composition_id, *layer_id)?;
                let slot = layer.transform.property_mut(*property);
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
                let layer = project.operation_layer_mut(*composition_id, *layer_id)?;
                let slot = layer.transform.property_mut(*property);
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
                let layer = project.operation_layer_mut(*composition_id, *layer_id)?;
                let slot = layer.transform.property_mut(*property);
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
        let (staged, inverses) = Operation::apply_all(project, &operations)?;
        *project = staged;
        self.undo.push(HistoryEntry {
            forward: operations,
            inverse: inverses,
        });
        self.redo.clear();
        Ok(())
    }

    pub fn undo(&mut self, project: &mut Project) -> Result<bool, OperationError> {
        let Some(entry) = self.undo.last() else {
            return Ok(false);
        };
        let (staged, _) = Operation::apply_all(project, &entry.inverse)?;
        self.redo.push(entry.clone());
        self.undo.pop();
        *project = staged;
        Ok(true)
    }

    pub fn redo(&mut self, project: &mut Project) -> Result<bool, OperationError> {
        let Some(entry) = self.redo.last() else {
            return Ok(false);
        };
        let (staged, _) = Operation::apply_all(project, &entry.forward)?;
        self.undo.push(entry.clone());
        self.redo.pop();
        *project = staged;
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

impl Operation {
    // Apply against a candidate so failed batches cannot publish partial edits or lose history.
    fn apply_all(
        project: &Project,
        operations: &[Self],
    ) -> Result<(Project, Vec<Self>), OperationError> {
        let mut staged = project.clone();
        let mut inverses = Vec::with_capacity(operations.len());
        for operation in operations {
            inverses.push(operation.apply(&mut staged)?);
        }
        inverses.reverse();
        Ok((staged, inverses))
    }
}

impl Project {
    fn operation_layer_mut(
        &mut self,
        composition_id: Uuid,
        layer_id: Uuid,
    ) -> Result<&mut Layer, OperationError> {
        self.composition_mut(composition_id)
            .ok_or(OperationError::CompositionNotFound(composition_id))?
            .layer_mut(layer_id)
            .ok_or(OperationError::LayerNotFound(layer_id))
    }
}

impl Transform {
    fn property_mut(&mut self, property: PropertyKey) -> &mut Animatable {
        match property {
            PropertyKey::PositionX => &mut self.position_x,
            PropertyKey::PositionY => &mut self.position_y,
            PropertyKey::PositionZ => &mut self.position_z,
            PropertyKey::RotationX => &mut self.rotation_x,
            PropertyKey::RotationY => &mut self.rotation_y,
            PropertyKey::RotationZ => &mut self.rotation_z,
            PropertyKey::ScaleX => &mut self.scale_x,
            PropertyKey::ScaleY => &mut self.scale_y,
            PropertyKey::ScaleZ => &mut self.scale_z,
            PropertyKey::AnchorX => &mut self.anchor_x,
            PropertyKey::AnchorY => &mut self.anchor_y,
            PropertyKey::AnchorZ => &mut self.anchor_z,
            PropertyKey::Opacity => &mut self.opacity,
        }
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

    impl Project {
        fn fixture() -> Result<Project, aster_timeline::TimeError> {
            let composition_id = Uuid::new_v4();
            Ok(Project {
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
                    duration: Time::new(10, 1)?,
                    background: [0.0, 0.0, 0.0, 1.0],
                    layers: Vec::new(),
                }],
            })
        }
    }

    impl Layer {
        fn fixture() -> Result<Layer, aster_timeline::TimeError> {
            Ok(Layer {
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
                out_point: Time::new(10, 1)?,
                blend_mode: BlendMode::Normal,
                transform: Transform::default(),
                effects: Vec::new(),
            })
        }
    }

    #[test]
    fn transaction_undo_and_redo_are_deterministic() -> Result<(), Box<dyn std::error::Error>> {
        let mut project = Project::fixture()?;
        let composition_id = project.active_composition;
        let layer = Layer::fixture()?;
        let mut history = OperationHistory::default();
        history.execute(
            &mut project,
            vec![Operation::AddLayer {
                composition_id,
                layer: Box::new(layer.clone()),
            }],
        )?;
        assert_eq!(project.compositions[0].layers.len(), 1);
        history.undo(&mut project)?;
        assert!(project.compositions[0].layers.is_empty());
        history.redo(&mut project)?;
        assert_eq!(project.compositions[0].layers[0].id, layer.id);
        Ok(())
    }

    #[test]
    fn failed_batch_preserves_layer_order_parents_and_existing_history()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut project = Project::fixture()?;
        let composition_id = project.active_composition;
        let parent = Layer::fixture()?;
        let mut child = Layer::fixture()?;
        child.parent = Some(parent.id);
        project.compositions[0].layers = vec![parent.clone(), child];
        let before = project.clone();
        let mut history = OperationHistory::default();
        assert!(
            history
                .execute(
                    &mut project,
                    vec![
                        Operation::RemoveLayer {
                            composition_id,
                            layer_id: parent.id
                        },
                        Operation::RemoveLayer {
                            composition_id,
                            layer_id: Uuid::new_v4()
                        },
                    ]
                )
                .is_err()
        );
        assert_eq!(project, before);
        assert!(!history.can_undo());
        history.execute(
            &mut project,
            vec![Operation::RenameLayer {
                composition_id,
                layer_id: parent.id,
                name: "Updated".into(),
            }],
        )?;
        let saved_layers = std::mem::take(&mut project.compositions[0].layers);
        let missing = project.clone();
        assert!(history.undo(&mut project).is_err());
        assert_eq!(project, missing);
        assert!(history.can_undo());
        project.compositions[0].layers = saved_layers;
        assert!(history.undo(&mut project)?);
        assert_eq!(project, before);
        let saved_layers = std::mem::take(&mut project.compositions[0].layers);
        let missing = project.clone();
        assert!(history.redo(&mut project).is_err());
        assert_eq!(project, missing);
        assert!(history.can_redo());
        project.compositions[0].layers = saved_layers;
        assert!(history.redo(&mut project)?);
        assert_eq!(project.compositions[0].layers[0].name, "Updated");
        Ok(())
    }
}
