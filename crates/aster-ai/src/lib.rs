//! Provider-agnostic, auditable operation plans for AI-assisted editing.

use std::collections::BTreeSet;

use aster_core::{Operation, OperationError, OperationHistory, Project};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

mod provider;
mod tool;

pub use provider::{
    AiProvider, AiProviderConfig, GeneratedPlan, OpenAiCompatibleProvider, ProviderError,
    ProviderFuture, generate_plan,
};
pub use tool::{AiTool, AiToolDefinition, SubmitOperationPlanTool, ToolError};

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct OperationPlan {
    pub id: Uuid,
    pub summary: String,
    pub operations: Vec<Operation>,
    #[serde(default)]
    pub required_permissions: BTreeSet<Permission>,
}

impl OperationPlan {
    pub fn preview(&self, project: &Project) -> Result<PlanPreview, AiError> {
        self.validate_permissions(&BTreeSet::from([Permission::EditProject]))?;
        let mut preview = project.clone();
        let mut history = OperationHistory::default();
        history.execute(&mut preview, self.operations.clone())?;
        Ok(PlanPreview {
            plan_id: self.id,
            summary: self.summary.clone(),
            operation_count: self.operations.len(),
            project: preview,
        })
    }

    pub fn apply(
        &self,
        project: &mut Project,
        history: &mut OperationHistory,
        granted: &BTreeSet<Permission>,
    ) -> Result<AuditEntry, AiError> {
        self.validate_permissions(granted)?;
        history.execute(project, self.operations.clone())?;
        Ok(AuditEntry {
            plan_id: self.id,
            summary: self.summary.clone(),
            operation_count: self.operations.len(),
            accepted: true,
        })
    }

    fn validate_permissions(&self, granted: &BTreeSet<Permission>) -> Result<(), AiError> {
        let missing: Vec<_> = self
            .required_permissions
            .difference(granted)
            .copied()
            .collect();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(AiError::PermissionDenied(missing))
        }
    }
}

pub fn operation_schema() -> Result<serde_json::Value, serde_json::Error> {
    serde_json::to_value(schema_for!(Operation))
}

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    EditProject,
    ReadAssets,
    ImportAssets,
    Network,
}

#[derive(Clone, Debug, Serialize)]
pub struct PlanPreview {
    pub plan_id: Uuid,
    pub summary: String,
    pub operation_count: usize,
    pub project: Project,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AuditEntry {
    pub plan_id: Uuid,
    pub summary: String,
    pub operation_count: usize,
    pub accepted: bool,
}

#[derive(Debug, Error)]
pub enum AiError {
    #[error("operation failed: {0}")]
    Operation(#[from] OperationError),
    #[error("operation plan requires permissions: {0:?}")]
    PermissionDenied(Vec<Permission>),
}
