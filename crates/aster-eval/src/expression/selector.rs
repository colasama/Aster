use super::{
    ExpressionContext, ExpressionError, ExpressionLimits, ExpressionProgram, lexer::Tokens,
    parser::Parser,
};

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextExpressionContext {
    pub time: f64,
    pub text_index: f64,
    pub text_total: f64,
    pub selector_value: f64,
}

#[derive(Clone, Debug)]
pub struct TextExpressionBinding {
    program: Option<ExpressionProgram>,
    pub compile_error: Option<ExpressionError>,
}

impl TextExpressionBinding {
    pub fn compile(source: &str, limits: &ExpressionLimits) -> Self {
        match Tokens::scan_selector(source, limits)
            .and_then(|tokens| Parser::compile(tokens, limits, true))
        {
            Ok(instructions) => Self {
                program: Some(ExpressionProgram {
                    instructions,
                    selector: true,
                }),
                compile_error: None,
            },
            Err(error) => Self {
                program: None,
                compile_error: Some(error),
            },
        }
    }

    pub fn evaluate(&self, context: TextExpressionContext) -> Result<f64, ExpressionError> {
        let program = self.program.as_ref().ok_or_else(|| {
            self.compile_error
                .clone()
                .unwrap_or_else(|| ExpressionError::Syntax("missing expression program".into()))
        })?;
        program.evaluate_context(
            ExpressionContext {
                time: context.time,
                value: context.selector_value,
            },
            [context.text_index, context.text_total],
        )
    }

    pub fn evaluate_or_fallback(&self, context: TextExpressionContext) -> f64 {
        match self.evaluate(context) {
            Ok(value) => value,
            Err(_) => context.selector_value,
        }
    }
}
