use serde::Serialize;
use serde_json::{Value, json};
use thiserror::Error;

use crate::provider::GeneratedPlan;

#[derive(Clone, Debug, Serialize)]
pub struct AiToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
}

pub trait AiTool: Send + Sync {
    type Output;

    fn definition(&self) -> AiToolDefinition;
    fn decode(&self, arguments: &str) -> Result<Self::Output, ToolError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SubmitOperationPlanTool;

impl SubmitOperationPlanTool {
    pub const NAME: &str = "submit_operation_plan";
}

impl AiTool for SubmitOperationPlanTool {
    type Output = GeneratedPlan;

    fn definition(&self) -> AiToolDefinition {
        AiToolDefinition {
            name: Self::NAME,
            description: "Submit one reversible Aster editor operation plan for user preview.",
            parameters: json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["summary", "operations"],
                "properties": {
                    "summary": { "type": "string", "minLength": 1, "maxLength": 500 },
                    "operations": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 12,
                        "items": {
                            "type": "object",
                            "required": ["type"],
                            "properties": { "type": { "type": "string" } }
                        }
                    }
                }
            }),
        }
    }

    fn decode(&self, arguments: &str) -> Result<GeneratedPlan, ToolError> {
        let plan: GeneratedPlan = serde_json::from_str(arguments)?;
        if plan.summary.trim().is_empty() {
            return Err(ToolError::EmptySummary);
        }
        if plan.operations.is_empty() || plan.operations.len() > 12 {
            return Err(ToolError::InvalidOperationCount(plan.operations.len()));
        }
        Ok(plan)
    }
}

#[derive(Debug, Error)]
pub enum ToolError {
    #[error("AI tool arguments are invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("AI operation plan summary is empty")]
    EmptySummary,
    #[error("AI operation plan contains {0} operations; expected 1 through 12")]
    InvalidOperationCount(usize),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_plan_tool_has_a_bounded_schema_and_decoder() {
        let tool = SubmitOperationPlanTool;
        let definition = tool.definition();
        assert_eq!(definition.name, SubmitOperationPlanTool::NAME);
        assert_eq!(
            definition
                .parameters
                .pointer("/properties/operations/maxItems"),
            Some(&json!(12))
        );
        let plan = tool
            .decode(r#"{"summary":"Tint","operations":[{"type":"addEffect"}]}"#)
            .unwrap();
        assert_eq!(plan.summary, "Tint");
        assert!(matches!(
            tool.decode(r#"{"summary":"Empty","operations":[]}"#),
            Err(ToolError::InvalidOperationCount(0))
        ));
    }
}
