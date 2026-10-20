use super::{EvaluatedSceneLayer, PrecompositionSurface, SceneProject};
use crate::{EvaluatedTransform, EvaluationError};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
struct Evaluation {
    transforms: BTreeMap<(usize, u64), Vec<Option<EvaluatedTransform>>>,
}

struct FlattenInput {
    composition: usize,
    time: f64,
    parent: Option<EvaluatedTransform>,
    instance_prefix: String,
    resource_prefix: String,
    selection_id: Option<String>,
    path: Vec<usize>,
}

impl SceneProject {
    pub fn camera(
        &self,
        composition_id: &str,
        time: f64,
    ) -> Result<Option<crate::EvaluatedCamera>, EvaluationError> {
        if !time.is_finite() {
            return Err(EvaluationError::InvalidTime);
        }
        let index = self.composition_index(composition_id)?;
        let composition = &self.compositions[index];
        for (layer, compiled) in self.project.compositions[index]
            .layers
            .iter()
            .zip(&composition.layers)
        {
            if let Some(camera) = &compiled.camera
                && layer.visible
                && time >= compiled.clock.in_point - 1e-9
                && time < compiled.out_point - 1e-9
            {
                let transform = self.world_transform(composition_id, &layer.id, time)?;
                return Ok(Some(camera.evaluate(
                    &transform,
                    time,
                    composition.size[0],
                )?));
            }
        }
        Ok(None)
    }

    pub fn visible_layer_ids(
        &self,
        composition_id: &str,
        time: f64,
    ) -> Result<Vec<String>, EvaluationError> {
        if !time.is_finite() {
            return Err(EvaluationError::InvalidTime);
        }
        let composition = self.composition_index(composition_id)?;
        Ok(self
            .visible_indices(composition, time)
            .into_iter()
            .map(|i| self.project.compositions[composition].layers[i].id.clone())
            .collect())
    }

    fn visible_indices(&self, composition: usize, time: f64) -> Vec<usize> {
        let layers = &self.project.compositions[composition].layers;
        let mut active: Vec<_> = layers
            .iter()
            .enumerate()
            .filter(|(index, layer)| {
                let compiled = &self.compositions[composition].layers[*index];
                layer.visible
                    && time >= compiled.clock.in_point - 1e-9
                    && time < compiled.out_point - 1e-9
            })
            .map(|(index, _)| index)
            .collect();
        if active.iter().any(|index| layers[*index].solo) {
            active.retain(|index| layers[*index].solo);
        }
        active
    }

    pub fn source_time(
        &self,
        composition_id: &str,
        layer_id: &str,
        time: f64,
        duration: f64,
    ) -> Result<f64, EvaluationError> {
        let composition = &self.compositions[self.composition_index(composition_id)?];
        let index = composition
            .layer_indices
            .get(layer_id)
            .ok_or_else(|| EvaluationError::InvalidScene("unknown layer".into()))?;
        composition.layers[*index].clock.evaluate(time, duration)
    }

    pub fn world_transform(
        &self,
        composition_id: &str,
        layer_id: &str,
        time: f64,
    ) -> Result<EvaluatedTransform, EvaluationError> {
        if !time.is_finite() {
            return Err(EvaluationError::InvalidTime);
        }
        let composition = self.composition_index(composition_id)?;
        let index = self.compositions[composition]
            .layer_indices
            .get(layer_id)
            .ok_or_else(|| EvaluationError::InvalidScene("unknown layer".into()))?;
        self.resolve_transform(composition, *index, time, &mut Evaluation::default())
    }

    fn resolve_transform(
        &self,
        composition: usize,
        layer: usize,
        time: f64,
        evaluation: &mut Evaluation,
    ) -> Result<EvaluatedTransform, EvaluationError> {
        let layers = &self.compositions[composition].layers;
        let cache = evaluation
            .transforms
            .entry((composition, if time == 0. { 0 } else { time.to_bits() }))
            .or_insert_with(|| vec![None; layers.len()]);
        let mut path = Vec::new();
        let mut visited = BTreeSet::new();
        let mut current = layer;
        let mut cycle = false;
        let mut world = loop {
            if let Some(cached) = &cache[current] {
                break cached.clone();
            }
            let local = layers[current].transform.evaluate(time)?;
            if !visited.insert(current) {
                cycle = true;
                break local;
            }
            path.push((current, local.clone()));
            match layers[current].parent {
                Some(parent) => current = parent,
                None => {
                    path.pop();
                    cache[current] = Some(local.clone());
                    break local;
                }
            }
        };
        for (index, local) in path.into_iter().rev() {
            world = local.compose_parent(&world);
            if !cycle {
                cache[index] = Some(world.clone());
            }
        }
        Ok(world)
    }

    pub fn evaluate(
        &self,
        composition_id: &str,
        time: f64,
    ) -> Result<Vec<EvaluatedSceneLayer>, EvaluationError> {
        if !time.is_finite() {
            return Err(EvaluationError::InvalidTime);
        }
        self.flatten(
            FlattenInput {
                composition: self.composition_index(composition_id)?,
                time,
                parent: None,
                instance_prefix: "root".into(),
                resource_prefix: "root".into(),
                selection_id: None,
                path: Vec::new(),
            },
            &mut Evaluation::default(),
        )
    }

    fn flatten(
        &self,
        input: FlattenInput,
        evaluation: &mut Evaluation,
    ) -> Result<Vec<EvaluatedSceneLayer>, EvaluationError> {
        if input.path.contains(&input.composition) {
            return Ok(Vec::new());
        }
        if input.path.len() >= self.limits.max_composition_depth {
            return Err(EvaluationError::InvalidScene(
                "composition depth budget exceeded".into(),
            ));
        }
        let composition = &self.compositions[input.composition];
        let source = &self.project.compositions[input.composition];
        let mut path = input.path.clone();
        path.push(input.composition);
        let mut output = Vec::new();
        for index in self.visible_indices(input.composition, input.time) {
            if output.len() >= 65536 {
                break;
            }
            let layer = &source.layers[index];
            let compiled = &composition.layers[index];
            if layer.kind == "adjustment" && !input.path.is_empty() {
                return Err(EvaluationError::InvalidScene(
                    "nested adjustment requires a texture surface wrapper".into(),
                ));
            }
            let local = self.resolve_transform(input.composition, index, input.time, evaluation)?;
            let clones = if layer.kind == "adjustment" {
                None
            } else {
                compiled
                    .cloner
                    .as_ref()
                    .map(|cloner| cloner.evaluate(input.time, None))
                    .transpose()?
            };
            let count = clones.as_ref().map_or(1, |frame| frame.instances.len());
            for clone_index in 0..count {
                if output.len() >= 65536 {
                    break;
                }
                let clone = clones.as_ref().map(|frame| &frame.instances[clone_index]);
                let local =
                    clone.map_or_else(|| local.clone(), |instance| instance.compose(&local));
                let transform = match &input.parent {
                    Some(parent) => local.map_nested(parent, composition.size),
                    None => local,
                };
                let selection_id = match &input.selection_id {
                    Some(selection) => selection.clone(),
                    None => layer.id.clone(),
                };
                let instance_id = match clone {
                    Some(instance) => format!(
                        "{}/{}:clone-{}",
                        input.instance_prefix, layer.id, instance.index
                    ),
                    None => format!("{}/{}", input.instance_prefix, layer.id),
                };
                let resource_instance_id = format!("{}/{}", input.resource_prefix, layer.id);
                let mut surface = None;
                if let Some(nested_index) = compiled.nested {
                    let nested = &self.compositions[nested_index];
                    let time = compiled.clock.evaluate(input.time, nested.duration)?;
                    if compiled.surface || nested.contains_camera {
                        surface = Some(PrecompositionSurface {
                            composition_id: self.project.compositions[nested_index].id.clone(),
                            time,
                            composition_path: path
                                .iter()
                                .map(|i| self.project.compositions[*i].id.clone())
                                .collect(),
                        });
                    } else {
                        let children = self.flatten(
                            FlattenInput {
                                composition: nested_index,
                                time,
                                parent: Some(transform.wrapper_size(compiled.size, nested.size)),
                                instance_prefix: instance_id,
                                resource_prefix: resource_instance_id,
                                selection_id: Some(selection_id),
                                path: path.clone(),
                            },
                            evaluation,
                        )?;
                        output.extend(children.into_iter().take(65536 - output.len()));
                        continue;
                    }
                }
                output.push(EvaluatedSceneLayer {
                    layer_id: layer.id.clone(),
                    source_composition_id: source.id.clone(),
                    transform,
                    local_time: input.time,
                    instance_id,
                    resource_instance_id,
                    selection_id,
                    precomposition_surface: surface,
                });
            }
        }
        Ok(output)
    }
}
