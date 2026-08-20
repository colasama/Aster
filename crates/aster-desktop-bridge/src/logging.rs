use tracing_subscriber::{EnvFilter, fmt};

/// Installs JSON tracing on stderr, keeping stdout reserved for the bridge protocol.
pub fn init() -> Result<(), String> {
    let level = std::env::var("ASTER_LOG")
        .ok()
        .filter(|level| matches!(level.as_str(), "debug" | "info" | "warn" | "error"))
        .unwrap_or_else(|| "info".to_owned());
    let filter = EnvFilter::new(format!("warn,aster_desktop_bridge={level}"));
    fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .json()
        .try_init()
        .map_err(|error| error.to_string())
}
