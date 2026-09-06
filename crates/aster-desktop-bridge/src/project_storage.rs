use crate::project_media::{MediaOperation, ProjectMedia};
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinkedProjectAsset {
    pub(crate) relative_path: String,
    pub(crate) resolved_path: PathBuf,
    pub(crate) name: String,
    pub(crate) content_identity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) media_metadata: Option<LinkedMediaMetadata>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinkedMediaMetadata {
    pub(crate) duration: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) audio: Option<LinkedAudioMetadata>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinkedAudioMetadata {
    pub(crate) stream_index: u32,
    pub(crate) channels: u8,
    pub(crate) sample_rate: u32,
}

#[derive(Default)]
pub(crate) struct ProjectStorage {
    pub(crate) media: ProjectMedia,
    pub(crate) bundle_limits: aster_project::BundleLimits,
}

impl ProjectStorage {
    pub(crate) fn bundle(&self, root: impl AsRef<Path>) -> aster_project::ProjectBundle {
        aster_project::ProjectBundle {
            root: root.as_ref().to_owned(),
            limits: self.bundle_limits.clone(),
        }
    }

    pub(crate) fn save_project(
        &self,
        path: String,
        mut project: serde_json::Value,
    ) -> Result<(), String> {
        let bundle = PathBuf::from(path);
        aster_project::ProjectBundle::validate_editor(&project, false)
            .map_err(|error| error.to_string())?;
        let bundle = self
            .bundle(&bundle)
            .prepare_directory()
            .map_err(|error| error.to_string())?;
        self.media
            .process(&bundle, &mut project, MediaOperation::Materialize)?;
        self.bundle(bundle)
            .save_editor(&project)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn unpack_project(&self, archive: String, parent: String) -> Result<String, String> {
        let archive = PathBuf::from(archive)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let parent = PathBuf::from(parent)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !archive.is_file() || !parent.is_dir() {
            return Err("packed project source and destination must exist".to_owned());
        }
        let stem = archive
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("Aster Project");
        let sanitized: String = stem
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || " -_".contains(character) {
                    character
                } else {
                    '-'
                }
            })
            .take(100)
            .collect();
        let base = if sanitized.trim().is_empty() {
            "Aster Project"
        } else {
            sanitized.trim()
        };
        let mut destination = parent.join(base);
        for suffix in 2..10_000 {
            if !destination.exists() {
                break;
            }
            destination = parent.join(format!("{base}-{suffix}"));
        }
        if destination.exists() {
            return Err("unable to allocate an unpacked project directory".to_owned());
        }
        self.bundle(&destination)
            .unpack(&archive)
            .map_err(|error| error.to_string())?;
        Ok(destination.to_string_lossy().into_owned())
    }

    pub(crate) fn save_autosave(
        &self,
        path: String,
        mut project: serde_json::Value,
    ) -> Result<(), String> {
        let bundle = PathBuf::from(path);
        aster_project::ProjectBundle::validate_editor(&project, false)
            .map_err(|error| error.to_string())?;
        let bundle = self
            .bundle(&bundle)
            .prepare_directory()
            .map_err(|error| error.to_string())?;
        self.media
            .process(&bundle, &mut project, MediaOperation::Materialize)?;
        self.bundle(bundle)
            .save_autosave(&project)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn write_render_frame(
        directory: &str,
        file_name: &str,
        data: &str,
    ) -> Result<(), String> {
        if !Self::valid_render_frame_name(file_name) {
            return Err("render frame name must match frame_000001.png".to_owned());
        }
        let directory = PathBuf::from(directory);
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|error| error.to_string())?;
        let destination = directory.join(file_name);
        aster_project::AtomicFile::write(&destination, |file| file.write_all(&bytes))
            .map_err(|error| error.to_string())
    }

    pub(crate) fn load_project(&self, path: String) -> Result<serde_json::Value, String> {
        let bundle = PathBuf::from(path);
        let mut project = self
            .bundle(&bundle)
            .load_editor()
            .map_err(|error| error.to_string())?;
        let bundle = bundle.canonicalize().map_err(|error| error.to_string())?;
        Self::resolve_project_asset_paths(&bundle, &mut project)?;
        self.media
            .process(&bundle, &mut project, MediaOperation::Resolve)?;
        Ok(project)
    }

    pub(crate) fn resolve_project_asset_paths(
        bundle: &Path,
        project: &mut serde_json::Value,
    ) -> Result<Vec<PathBuf>, String> {
        let mut assets = Vec::new();
        for source in project
            .get_mut("sources")
            .and_then(serde_json::Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            let Some(source) = source.as_object_mut() else {
                continue;
            };
            if let Some(resolved) = Self::resolve_asset(bundle, source)? {
                assets.push(resolved);
            }
        }
        for composition in project
            .get_mut("compositions")
            .and_then(serde_json::Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            for layer in composition
                .get_mut("layers")
                .and_then(serde_json::Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                let Some(asset) = layer
                    .get_mut("asset")
                    .and_then(serde_json::Value::as_object_mut)
                else {
                    continue;
                };
                if let Some(resolved) = Self::resolve_asset(bundle, asset)? {
                    assets.push(resolved);
                }
            }
        }
        Ok(assets)
    }

    fn resolve_asset(
        bundle: &Path,
        asset: &mut serde_json::Map<String, serde_json::Value>,
    ) -> Result<Option<PathBuf>, String> {
        let Some(relative) = asset
            .get("relativePath")
            .and_then(serde_json::Value::as_str)
        else {
            return Ok(None);
        };
        let candidate = bundle.join(Self::safe_relative_path(relative)?);
        if !candidate.is_file() {
            return Ok(None);
        }
        let resolved = candidate
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !resolved.starts_with(bundle) {
            return Err("relative asset resolves outside the project bundle".to_owned());
        }
        asset.insert(
            "resolvedPath".to_owned(),
            serde_json::Value::String(resolved.to_string_lossy().into_owned()),
        );
        Ok(Some(resolved))
    }

    pub(crate) fn link_asset(
        bundle: &str,
        source: &str,
        kind: &str,
    ) -> Result<LinkedProjectAsset, String> {
        let bundle = PathBuf::from(bundle)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let source = PathBuf::from(source)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !source.is_file() || !Self::valid_asset_extension(&source, kind) {
            return Err(format!("selected file is not a supported {kind} asset"));
        }
        let (resolved, content_identity, media_metadata) = if source.starts_with(&bundle) {
            let identity = Self::sha256_file_identity(&source)?;
            let metadata = Self::probe_linked_media(&source, kind)?;
            (source, identity, metadata)
        } else {
            let assets = bundle.join("assets");
            fs::create_dir_all(&assets).map_err(|error| error.to_string())?;
            let assets = assets.canonicalize().map_err(|error| error.to_string())?;
            if !assets.starts_with(&bundle) {
                return Err("asset directory resolves outside the project bundle".to_owned());
            }
            let destination = Self::available_asset_destination(&assets, &source)?;
            let (pending, mut output) = aster_project::AtomicFile::stage(&destination)
                .map_err(|error| error.to_string())?;
            std::io::copy(
                &mut fs::File::open(&source).map_err(|error| error.to_string())?,
                &mut output,
            )
            .map_err(|error| error.to_string())?;
            drop(output);
            // Inspect the copied snapshot so failed probes never publish unusable media.
            let identity = Self::sha256_file_identity(&pending.temporary)?;
            let metadata = Self::probe_linked_media(&pending.temporary, kind)?;
            pending.publish(false).map_err(|error| error.to_string())?;
            (destination, identity, metadata)
        };
        let relative = resolved
            .strip_prefix(&bundle)
            .map_err(|_| "linked asset must stay inside the project bundle".to_owned())?;
        let relative_path = relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        Ok(LinkedProjectAsset {
            relative_path,
            name: resolved
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("asset")
                .to_owned(),
            content_identity,
            media_metadata,
            resolved_path: resolved,
        })
    }

    pub(crate) fn probe_linked_media(
        path: &Path,
        kind: &str,
    ) -> Result<Option<LinkedMediaMetadata>, String> {
        if kind != "audio" && kind != "video" {
            return Ok(None);
        }
        let metadata = aster_video::FfprobeBackend::default()
            .probe(path, &aster_video::CancellationToken::default())
            .map_err(|error| format!("unable to inspect linked {kind} metadata: {error}"))?;
        let duration = metadata
            .timebase
            .seconds(metadata.duration_ticks)
            .map_err(|error| error.to_string())?;
        if !duration.is_finite() || duration <= 0.0 || duration > 86_400.0 {
            return Err("linked media duration exceeds the supported range".to_owned());
        }
        let audio = metadata
            .select_audio_stream()
            .ok()
            .map(|stream| LinkedAudioMetadata {
                stream_index: stream.index,
                channels: stream.channels,
                sample_rate: stream.sample_rate,
            });
        if kind == "audio" && audio.is_none() {
            return Err("linked audio file has no usable audio stream".to_owned());
        }
        let video = if kind == "video" {
            Some(
                metadata
                    .select_video_stream()
                    .map_err(|error| error.to_string())?,
            )
        } else {
            None
        };
        Ok(Some(LinkedMediaMetadata {
            duration,
            width: video.map(|stream| stream.width),
            height: video.map(|stream| stream.height),
            audio,
        }))
    }

    pub(crate) fn sha256_file_identity(path: &Path) -> Result<String, String> {
        let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        Ok(format!("sha256:{:x}", digest.finalize()))
    }

    pub(crate) fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
        let path = Path::new(value);
        if value.is_empty()
            || value.contains('\\')
            || path
                .components()
                .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
        {
            return Err("asset relativePath must stay inside the project bundle".to_owned());
        }
        Ok(path.to_owned())
    }

    pub(crate) fn valid_asset_extension(path: &Path, kind: &str) -> bool {
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        match kind {
            "image" => {
                ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"].contains(&extension.as_str())
            }
            "video" => ["mp4", "webm", "mov", "m4v", "ogv"].contains(&extension.as_str()),
            "audio" => ["wav", "mp3", "aac", "m4a", "ogg", "flac"].contains(&extension.as_str()),
            _ => false,
        }
    }

    pub(crate) fn available_asset_destination(
        directory: &Path,
        source: &Path,
    ) -> Result<PathBuf, String> {
        let file_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("asset.bin");
        let sanitized: String = file_name
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || ".-_".contains(character) {
                    character
                } else {
                    '-'
                }
            })
            .take(160)
            .collect();
        let initial = directory.join(&sanitized);
        if !initial.exists() {
            return Ok(initial);
        }
        let path = Path::new(&sanitized);
        let stem = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("asset");
        let extension = path.extension().and_then(|extension| extension.to_str());
        for index in 2..10_000 {
            let name = match extension {
                Some(extension) => format!("{stem}-{index}.{extension}"),
                None => format!("{stem}-{index}"),
            };
            let candidate = directory.join(name);
            if !candidate.exists() {
                return Ok(candidate);
            }
        }
        Err("unable to allocate a linked asset filename".to_owned())
    }

    pub(crate) fn valid_render_frame_name(name: &str) -> bool {
        let bytes = name.as_bytes();
        bytes.len() == 16
            && bytes.starts_with(b"frame_")
            && bytes.ends_with(b".png")
            && bytes[6..12].iter().all(u8::is_ascii_digit)
    }

    pub(crate) fn recovery_candidate(
        &self,
        path: String,
    ) -> Result<Option<serde_json::Value>, String> {
        let bundle = PathBuf::from(path);
        let mut candidate = self
            .bundle(&bundle)
            .recovery_candidate()
            .map_err(|error| error.to_string())?;
        if let Some(project) = candidate.as_mut() {
            let bundle = bundle.canonicalize().map_err(|error| error.to_string())?;
            Self::resolve_project_asset_paths(&bundle, project)?;
            self.media
                .process(&bundle, project, MediaOperation::Resolve)?;
        }
        Ok(candidate)
    }
}
