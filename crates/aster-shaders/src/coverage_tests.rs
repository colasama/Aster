use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

use crate::{ShaderCatalog, ShaderManifest};

struct DiskShaders {
    sources: BTreeMap<String, String>,
}

impl DiskShaders {
    fn read(root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let mut directories = vec![root.to_path_buf()];
        let mut sources = BTreeMap::new();
        while let Some(directory) = directories.pop() {
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                let path = entry.path();
                let kind = entry.file_type()?;
                if kind.is_symlink() {
                    return Err(format!(
                        "Shared shader tree contains a symlink: {}",
                        path.display()
                    )
                    .into());
                }
                if kind.is_dir() {
                    directories.push(path);
                } else if path
                    .extension()
                    .is_some_and(|extension| extension == "wgsl")
                {
                    if !kind.is_file() {
                        return Err(
                            format!("Shader is not a regular file: {}", path.display()).into()
                        );
                    }
                    let relative = path
                        .strip_prefix(root)?
                        .to_str()
                        .ok_or("Non-UTF-8 shader path")?
                        .replace('\\', "/");
                    if sources
                        .insert(relative, fs::read_to_string(&path)?)
                        .is_some()
                    {
                        return Err("Duplicate shared shader path".into());
                    }
                }
            }
        }
        Ok(Self { sources })
    }
}

#[test]
fn every_disk_shader_is_embedded_byte_for_byte_and_reaches_a_validated_program()
-> Result<(), Box<dyn std::error::Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../shaders");
    let disk = DiskShaders::read(&root)?;
    let manifest_bytes = fs::read_to_string(root.join("manifest.json"))?;
    assert_eq!(
        manifest_bytes,
        include_str!("../../../shaders/manifest.json")
    );
    let manifest: ShaderManifest = serde_json::from_str(&manifest_bytes)?;
    let declared = manifest
        .fragments
        .values()
        .cloned()
        .collect::<BTreeSet<_>>();
    assert_eq!(
        disk.sources.keys().cloned().collect::<BTreeSet<_>>(),
        declared
    );
    assert_eq!(disk.sources, ShaderCatalog::embedded_sources());
    let catalog = ShaderCatalog::embedded()?;
    assert_eq!(
        catalog.programs.keys().collect::<Vec<_>>(),
        manifest.programs.keys().collect::<Vec<_>>()
    );
    Ok(())
}
