use crate::{
    ProjectRasterFrame, ProjectRenderError, ProjectRenderLimits,
    raster_manifest::{RasterManifest, RasterPayloadCache},
    raster_transport::RasterChannel,
};
use aster_eval::{ProjectResourceRequests, ResourcePreparationOperation, TextLayouts};
use aster_video::CancellationToken;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RasterProviderOptions {
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub bundle: PathBuf,
    pub bridge: PathBuf,
    pub timeout_ms: u64,
    #[serde(default)]
    pub cache_bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostConfiguration {
    address: String,
    token: String,
    project: PathBuf,
    project_sha256: String,
    bundle: PathBuf,
    bridge: PathBuf,
    profile: PathBuf,
    maximum_json_bytes: usize,
    maximum_pixel_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RasterProviderReady {
    pub locale: String,
    pub layouts: TextLayouts,
    pub maximum_dimension: u32,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum RasterRequest {
    Acquire {
        index: u64,
        request_sha256: String,
        preparation: ProjectResourceRequests,
        known_payloads: Vec<String>,
    },
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum RasterReply {
    Ready {
        protocol: u32,
        token: String,
        project_sha256: String,
        ready: RasterProviderReady,
    },
    Frame {
        index: u64,
        manifest: RasterManifest,
        payloads: Vec<PayloadLength>,
    },
    Error {
        message: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PayloadLength {
    file: String,
    byte_length: usize,
}

struct ProviderProcess {
    child: Option<Child>,
    directory: PathBuf,
    channel: Option<RasterChannel>,
}

pub struct NativeRasterProvider {
    process: ProviderProcess,
    pub ready: RasterProviderReady,
    limits: ProjectRenderLimits,
    index: u64,
    poisoned: bool,
    raster_history: bool,
    payload_cache: RasterPayloadCache,
}

impl NativeRasterProvider {
    pub fn start(
        options: RasterProviderOptions,
        project: &Path,
        project_sha256: &str,
        limits: ProjectRenderLimits,
        cancel: &CancellationToken,
    ) -> Result<Self, ProjectRenderError> {
        if cancel.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        if !(1..=300_000).contains(&options.timeout_ms)
            || options.arguments.len() > 32
            || options.arguments.iter().any(|s| s.len() > 32768)
            || !(32..=67_108_864).contains(&limits.render_project_input_bytes)
            || limits.render_project_pixel_bytes == 0
            || limits.render_project_pixel_bytes > 1_073_741_824
            || options.cache_bytes > limits.render_project_pixel_bytes
        {
            return Err(ProjectRenderError::Invalid(
                "invalid raster provider limits".into(),
            ));
        }
        let executable = options.executable.canonicalize()?;
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let directory =
            std::env::temp_dir().join(format!("aster-native-raster-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory)?;
        let mut process = ProviderProcess {
            child: None,
            directory: directory.clone(),
            channel: None,
        };
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let config = HostConfiguration {
            address: listener.local_addr()?.to_string(),
            token: token.clone(),
            project: project.canonicalize()?,
            project_sha256: project_sha256.into(),
            bundle: options.bundle.canonicalize()?,
            bridge: options.bridge.canonicalize()?,
            profile: directory,
            maximum_json_bytes: limits.render_project_input_bytes,
            maximum_pixel_bytes: limits.render_project_pixel_bytes,
        };
        let mut command = Command::new(executable);
        command
            .args(options.arguments)
            .env(
                "ASTER_NATIVE_RASTER_CONNECT",
                serde_json::to_string(&config)?,
            )
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        process.child = Some(command.spawn()?);
        let started = Instant::now();
        let timeout = Duration::from_millis(options.timeout_ms);
        let socket = loop {
            if cancel.is_cancelled() {
                return Err(aster_video::FfmpegError::Cancelled.into());
            }
            if started.elapsed() >= timeout {
                return Err(ProjectRenderError::Invalid(
                    "raster provider startup timed out".into(),
                ));
            }
            if let Some(status) = process
                .child
                .as_mut()
                .ok_or_else(|| {
                    ProjectRenderError::Invalid("raster provider process absent".into())
                })?
                .try_wait()?
            {
                return Err(ProjectRenderError::Invalid(format!(
                    "raster provider exited before handshake: {status}"
                )));
            }
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(e) => return Err(e.into()),
            }
        };
        let mut channel = RasterChannel::new(socket, limits.render_project_input_bytes, timeout)?;
        let ready = match channel.receive(cancel)? {
            RasterReply::Ready {
                protocol: 1,
                token: received,
                project_sha256: loaded,
                ready,
            } if received == token
                && loaded == project_sha256
                && ready.maximum_dimension > 0
                && ready.maximum_dimension <= 8192 =>
            {
                ready
            }
            RasterReply::Error { message } => return Err(ProjectRenderError::Invalid(message)),
            _ => {
                return Err(ProjectRenderError::Invalid(
                    "raster provider handshake identity differs".into(),
                ));
            }
        };
        process.channel = Some(channel);
        Ok(Self {
            process,
            ready,
            limits,
            index: 0,
            poisoned: false,
            raster_history: false,
            payload_cache: RasterPayloadCache {
                budget_bytes: options.cache_bytes,
                entries: BTreeMap::new(),
            },
        })
    }

    pub fn acquire(
        &mut self,
        requests: &ProjectResourceRequests,
        cancel: &CancellationToken,
    ) -> Result<ProjectRasterFrame, ProjectRenderError> {
        if cancel.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        if self.poisoned {
            return Err(ProjectRenderError::Invalid(
                "raster provider is not ready".into(),
            ));
        }
        // Pure native scenes need no raster IPC. Once retained rasters have participated,
        // keep empty acquisitions so their temporal bounds and eviction history stay unchanged.
        if !self.raster_history
            && !requests
                .operations
                .iter()
                .any(|operation| matches!(operation, ResourcePreparationOperation::Raster { .. }))
        {
            return Ok(ProjectRasterFrame::default());
        }
        self.raster_history = true;
        let result = self.acquire_frame(requests, cancel);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }

    fn acquire_frame(
        &mut self,
        requests: &ProjectResourceRequests,
        cancel: &CancellationToken,
    ) -> Result<ProjectRasterFrame, ProjectRenderError> {
        let channel = self
            .process
            .channel
            .as_mut()
            .ok_or_else(|| ProjectRenderError::Invalid("raster channel absent".into()))?;
        channel.send(
            &RasterRequest::Acquire {
                index: self.index,
                request_sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(requests)?)),
                preparation: requests.clone(),
                known_payloads: self.payload_cache.entries.keys().cloned().collect(),
            },
            cancel,
        )?;
        let (manifest, payloads) = match channel.receive(cancel)? {
            RasterReply::Frame {
                index,
                manifest,
                payloads,
            } if index == self.index => (manifest, payloads),
            RasterReply::Error { message } => return Err(ProjectRenderError::Invalid(message)),
            _ => {
                return Err(ProjectRenderError::Invalid(
                    "raster response generation differs".into(),
                ));
            }
        };
        if payloads.len() > 65536
            || payloads
                .iter()
                .try_fold(0usize, |n, p| n.checked_add(p.byte_length))
                .is_none_or(|n| n > self.limits.render_project_pixel_bytes)
        {
            return Err(ProjectRenderError::Invalid(
                "raster transport payload budget exceeded".into(),
            ));
        }
        let mut payloads = payloads.into_iter();
        let frame = ProjectRasterFrame::admit(
            manifest,
            requests,
            &self.limits,
            cancel,
            Some(&mut self.payload_cache),
            |name, maximum| {
                let payload = payloads
                    .next()
                    .ok_or_else(|| ProjectRenderError::Invalid("raster payload absent".into()))?;
                if payload.file != name || payload.byte_length > maximum {
                    return Err(ProjectRenderError::Invalid(
                        "raster payload order or size differs".into(),
                    ));
                }
                channel.read_bytes(payload.byte_length, cancel)
            },
        )?;
        if payloads.next().is_some() {
            return Err(ProjectRenderError::Invalid("unused raster payload".into()));
        }
        self.index = self
            .index
            .checked_add(1)
            .ok_or_else(|| ProjectRenderError::Invalid("raster generation exhausted".into()))?;
        Ok(frame)
    }
}

impl Drop for ProviderProcess {
    fn drop(&mut self) {
        drop(self.channel.take());
        if let Some(mut child) = self.child.take() {
            let started = Instant::now();
            while child.try_wait().ok().flatten().is_none()
                && started.elapsed() < Duration::from_secs(1)
            {
                thread::sleep(Duration::from_millis(10));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        // The unique profile is owned only after exclusive directory creation succeeds.
        for _ in 0..5 {
            if fs::remove_dir_all(&self.directory).is_ok() || !self.directory.exists() {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}
