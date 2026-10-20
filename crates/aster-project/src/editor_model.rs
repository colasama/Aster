use aster_types::editor::Project;

use crate::{ProjectBundle, ProjectError};

impl ProjectBundle {
    /// Read persisted records without upgrading versions or dropping uninterpreted fields.
    pub fn load_editor_model(&self) -> Result<Project, ProjectError> {
        let document = self.load_editor()?;
        let project = serde_json::from_value(document)?;
        Ok(project)
    }

    /// Typed persistence uses the same schema admission and atomic publication as the editor.
    pub fn save_editor_model(&self, project: &Project) -> Result<(), ProjectError> {
        let document = serde_json::to_value(project)?;
        self.save_editor(&document)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
