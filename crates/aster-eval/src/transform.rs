use aster_types::editor::{Animatable, Layer, Transform};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::{EvaluationError, EvaluationLimits, ExpressionLimits, PropertyTrack};

#[derive(Clone, Debug)]
pub struct TransformTrack {
    position: VectorTrack,
    rotation: VectorTrack,
    scale: VectorTrack,
    anchor: VectorTrack,
    opacity: PropertyTrack,
}

#[derive(Clone, Debug)]
struct VectorTrack([PropertyTrack; 3]);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct EvaluatedTransform {
    pub position: [f64; 3],
    pub rotation: [f64; 3],
    pub scale: [f64; 3],
    pub anchor: [f64; 3],
    pub opacity: f64,
}

impl TransformTrack {
    pub fn compile(
        transform: &Transform,
        limits: &EvaluationLimits,
    ) -> Result<Self, EvaluationError> {
        Self::compile_with_expressions(
            transform,
            &BTreeMap::new(),
            limits,
            &ExpressionLimits::default(),
        )
    }

    pub fn compile_layer(
        layer: &Layer,
        limits: &EvaluationLimits,
        expression_limits: &ExpressionLimits,
    ) -> Result<Self, EvaluationError> {
        match layer.expressions.value() {
            Some(expressions) => Self::compile_with_expressions(
                &layer.transform,
                expressions,
                limits,
                expression_limits,
            ),
            None => Self::compile(&layer.transform, limits),
        }
    }

    pub fn compile_with_expressions(
        transform: &Transform,
        expressions: &BTreeMap<String, String>,
        limits: &EvaluationLimits,
        expression_limits: &ExpressionLimits,
    ) -> Result<Self, EvaluationError> {
        Ok(Self {
            position: VectorTrack::compile(
                &transform.position,
                "position",
                expressions,
                limits,
                expression_limits,
            )?,
            rotation: VectorTrack::compile(
                &transform.rotation,
                "rotation",
                expressions,
                limits,
                expression_limits,
            )?,
            scale: VectorTrack::compile(
                &transform.scale,
                "scale",
                expressions,
                limits,
                expression_limits,
            )?,
            anchor: VectorTrack::compile(
                &transform.anchor,
                "anchor",
                expressions,
                limits,
                expression_limits,
            )?,
            opacity: PropertyTrack::compile(
                &transform.opacity,
                expressions.get("opacity").map(String::as_str),
                limits,
                expression_limits,
            )?,
        })
    }

    pub fn evaluate(&self, time: f64) -> Result<EvaluatedTransform, EvaluationError> {
        Ok(EvaluatedTransform {
            position: self.position.evaluate(time)?,
            rotation: self.rotation.evaluate(time)?,
            scale: self.scale.evaluate(time)?,
            anchor: self.anchor.evaluate(time)?,
            opacity: self.opacity.evaluate(time)?.clamp(0.0, 100.0) / 100.0,
        })
    }
}

impl VectorTrack {
    fn compile(
        values: &[Animatable; 3],
        group: &str,
        expressions: &BTreeMap<String, String>,
        limits: &EvaluationLimits,
        expression_limits: &ExpressionLimits,
    ) -> Result<Self, EvaluationError> {
        Ok(Self([
            PropertyTrack::compile(
                &values[0],
                expressions.get(&format!("{group}.0")).map(String::as_str),
                limits,
                expression_limits,
            )?,
            PropertyTrack::compile(
                &values[1],
                expressions.get(&format!("{group}.1")).map(String::as_str),
                limits,
                expression_limits,
            )?,
            PropertyTrack::compile(
                &values[2],
                expressions.get(&format!("{group}.2")).map(String::as_str),
                limits,
                expression_limits,
            )?,
        ]))
    }

    fn evaluate(&self, time: f64) -> Result<[f64; 3], EvaluationError> {
        Ok([
            self.0[0].evaluate(time)?,
            self.0[1].evaluate(time)?,
            self.0[2].evaluate(time)?,
        ])
    }
}
