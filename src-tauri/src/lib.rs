use aster_core::Project;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RendererCapabilities {
    architecture: &'static str,
    backends: [&'static str; 3],
    shader_language: &'static str,
    project_schema: u32,
}

#[tauri::command]
fn renderer_capabilities() -> RendererCapabilities {
    let _ = aster_render::preferred_backends();
    RendererCapabilities {
        architecture: "GPU-first render graph",
        backends: ["Vulkan", "Metal", "DirectX 12"],
        shader_language: "WGSL",
        project_schema: Project::SCHEMA_VERSION,
    }
}

#[tauri::command]
fn operation_schema() -> Result<serde_json::Value, String> {
    aster_ai::operation_schema().map_err(|error| error.to_string())
}

#[tauri::command]
async fn generate_ai_plan(
    config: aster_ai::AiProviderConfig,
    prompt: String,
    project_summary: String,
) -> Result<aster_ai::GeneratedPlan, String> {
    aster_ai::generate_plan(config, &prompt, &project_summary)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_project(path: String, project: serde_json::Value) -> Result<(), String> {
    aster_project::save_editor_bundle(path, &project).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_project(path: String) -> Result<serde_json::Value, String> {
    aster_project::load_editor_bundle(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_autosave(path: String, project: serde_json::Value) -> Result<(), String> {
    aster_project::save_autosave(path, &project).map_err(|error| error.to_string())
}

#[tauri::command]
fn recovery_candidate(path: String) -> Result<Option<serde_json::Value>, String> {
    aster_project::recovery_candidate(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_autosave(path: String) -> Result<(), String> {
    aster_project::clear_autosave(path).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            clear_autosave,
            generate_ai_plan,
            load_project,
            operation_schema,
            recovery_candidate,
            renderer_capabilities,
            save_autosave,
            save_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
