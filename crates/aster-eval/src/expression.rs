mod functions;
mod lexer;
mod parser;
mod selector;
pub use selector::{TextExpressionBinding, TextExpressionContext};

pub(crate) use functions::NumericFunction;
use functions::Operator;
use parser::Parser;

#[derive(Clone, Debug, clap::Args)]
pub struct ExpressionLimits {
    #[arg(long, default_value_t = Self::default().max_expression_units)]
    pub max_expression_units: usize,
    #[arg(long, default_value_t = Self::default().max_expression_tokens)]
    pub max_expression_tokens: usize,
    #[arg(long, default_value_t = Self::default().max_expression_depth)]
    pub max_expression_depth: usize,
}

impl Default for ExpressionLimits {
    fn default() -> Self {
        Self {
            max_expression_units: 2048,
            max_expression_tokens: 512,
            max_expression_depth: 32,
        }
    }
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
pub struct ExpressionContext {
    pub time: f64,
    pub value: f64,
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum ExpressionError {
    #[error("Expression exceeds {0} budget")]
    Budget(&'static str),
    #[error("Invalid expression: {0}")]
    Syntax(String),
    #[error("Expression produced a non-finite value")]
    NonFinite,
}

#[derive(Clone, Debug)]
enum Instruction {
    Number(f64),
    Time,
    Value,
    TextIndex,
    TextTotal,
    Negate,
    Binary(Operator),
    Call(NumericFunction, usize),
}

#[derive(Clone, Debug)]
pub struct ExpressionProgram {
    instructions: Vec<Instruction>,
    selector: bool,
}

impl ExpressionProgram {
    pub fn compile(source: &str, limits: &ExpressionLimits) -> Result<Self, ExpressionError> {
        let tokens = lexer::Tokens::scan(source, limits)?;
        let instructions = Parser::compile(tokens, limits, false)?;
        Ok(Self {
            instructions,
            selector: false,
        })
    }

    pub fn evaluate(&self, context: ExpressionContext) -> Result<f64, ExpressionError> {
        self.evaluate_context(context, [0.0, 0.0])
    }

    fn evaluate_context(
        &self,
        context: ExpressionContext,
        text: [f64; 2],
    ) -> Result<f64, ExpressionError> {
        // Instructions and operands are bounded at compile time. Evaluation is iterative,
        // so long left-associative expressions cannot grow the native call stack.
        let mut stack = Vec::with_capacity(self.instructions.len());
        for instruction in &self.instructions {
            match *instruction {
                Instruction::Number(value) => stack.push(value),
                Instruction::Time => stack.push(context.time),
                Instruction::Value => stack.push(context.value),
                Instruction::TextIndex => stack.push(text[0]),
                Instruction::TextTotal => stack.push(text[1]),
                Instruction::Negate => {
                    let value = stack
                        .last_mut()
                        .ok_or_else(|| ExpressionError::Syntax("missing unary operand".into()))?;
                    *value = -*value;
                }
                Instruction::Binary(operator) => {
                    let right = stack
                        .pop()
                        .ok_or_else(|| ExpressionError::Syntax("missing right operand".into()))?;
                    let left = stack
                        .last_mut()
                        .ok_or_else(|| ExpressionError::Syntax("missing left operand".into()))?;
                    *left = if self.selector
                        && right == 0.0
                        && matches!(operator, Operator::Divide | Operator::Remainder)
                    {
                        f64::NAN
                    } else {
                        operator.evaluate(*left, right)
                    };
                }
                Instruction::Call(function, count) => {
                    let start = stack.len().checked_sub(count).ok_or_else(|| {
                        ExpressionError::Syntax("missing function arguments".into())
                    })?;
                    let value = if self.selector {
                        function.evaluate_selector(&stack[start..], context.time)?
                    } else {
                        function.evaluate(&stack[start..], context.time)?
                    };
                    stack.truncate(start);
                    stack.push(value);
                }
            }
        }
        match stack.as_slice() {
            [value] if value.is_finite() => Ok(if self.selector {
                value.clamp(-10_000.0, 10_000.0)
            } else {
                *value
            }),
            _ => Err(ExpressionError::NonFinite),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ExpressionBinding {
    program: Option<ExpressionProgram>,
    pub compile_error: Option<ExpressionError>,
}

impl ExpressionBinding {
    pub fn compile(source: &str, limits: &ExpressionLimits) -> Self {
        match ExpressionProgram::compile(source, limits) {
            Ok(program) => Self {
                program: Some(program),
                compile_error: None,
            },
            Err(error) => Self {
                program: None,
                compile_error: Some(error),
            },
        }
    }

    pub fn evaluate(&self, context: ExpressionContext) -> f64 {
        match self
            .program
            .as_ref()
            .map(|program| program.evaluate(context))
        {
            Some(Ok(value)) => value,
            _ => context.value,
        }
    }
}
