use std::collections::BTreeMap;

use crate::{ShaderCatalog, ShaderError};

impl ShaderCatalog {
    /// Rust and the browser consume these same checked-in files without generated shader copies.
    pub fn embedded() -> Result<Self, ShaderError> {
        Self::from_json(
            include_str!("../../../shaders/manifest.json"),
            BTreeMap::from([(
                "effects/anti-aliasing.wgsl".to_owned(),
                include_str!("../../../shaders/effects/anti-aliasing.wgsl").to_owned(),
            )]),
        )
    }
}
