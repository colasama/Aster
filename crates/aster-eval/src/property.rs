use aster_types::editor::Animatable;

use crate::{
    EvaluationError, EvaluationLimits, ExpressionBinding, ExpressionContext, ExpressionLimits,
    ScalarTrack,
};

#[derive(Clone, Debug)]
pub struct PropertyTrack {
    scalar: ScalarTrack,
    expression: Option<ExpressionBinding>,
}

impl PropertyTrack {
    pub fn compile(
        property: &Animatable,
        expression: Option<&str>,
        limits: &EvaluationLimits,
        expression_limits: &ExpressionLimits,
    ) -> Result<Self, EvaluationError> {
        Ok(Self {
            scalar: ScalarTrack::compile(property, limits)?,
            expression: expression
                .filter(|source| !source.is_empty())
                .map(|source| ExpressionBinding::compile(source, expression_limits)),
        })
    }

    pub fn evaluate(&self, time: f64) -> Result<f64, EvaluationError> {
        let value = self.scalar.evaluate(time)?;
        Ok(match &self.expression {
            Some(expression) => expression.evaluate(ExpressionContext { time, value }),
            None => value,
        })
    }
}
