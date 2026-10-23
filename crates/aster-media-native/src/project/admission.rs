use super::*;

impl NativeProjectMediaSession {
    /// Admit only broker-selected sources; preserve existing cache entries and video clocks.
    pub fn admit(
        &mut self,
        bindings: Vec<ProjectMediaBinding>,
        reader: &mut MediaSourceReader,
        cancellation: &CancellationToken,
    ) -> Result<(), MediaError> {
        if self.poisoned {
            return Err(MediaError::Authorization(
                "project media session is poisoned".into(),
            ));
        }
        let result = self.admit_sources(bindings, reader, cancellation);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }

    fn admit_sources(
        &mut self,
        bindings: Vec<ProjectMediaBinding>,
        reader: &mut MediaSourceReader,
        cancellation: &CancellationToken,
    ) -> Result<(), MediaError> {
        let limits = &self.limits;
        let scope = self.scope.as_str();
        if self
            .sources
            .len()
            .checked_add(bindings.len())
            .is_none_or(|n| n > limits.project_media_sources)
        {
            return Err(MediaError::Limit(
                "incremental project source budget exceeded".into(),
            ));
        }
        let mut sources = BTreeMap::new();
        let mut files = Vec::new();
        let mut snapshots = Vec::new();
        let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
        for binding in bindings {
            if cancellation.is_cancelled() {
                return Err(aster_video::FfmpegError::Cancelled.into());
            }
            let kind = match binding.source.kind.as_str() {
                "still" => MediaKind::Image,
                "video" => MediaKind::Video,
                "imageSequence" => MediaKind::Sequence,
                _ => {
                    return Err(MediaError::Unsupported(
                        "project decoder requires still, video or sequence sources".into(),
                    ));
                }
            };
            let source_id = binding.source.id.clone();
            if self.sources.contains_key(&source_id) || sources.contains_key(&source_id) {
                return Err(MediaError::Authorization("duplicate project source".into()));
            }
            let maximum = if kind == MediaKind::Video {
                limits.video.video_max_source_bytes
            } else {
                limits.still.still_max_source_bytes
            };
            let mut ordinary = if kind == MediaKind::Sequence {
                None
            } else {
                Some(binding.read(reader, None, maximum)?)
            };
            // The project authenticates historical locator identities before granting decoder bytes.
            let content_identity = match (binding.payload.as_deref(), ordinary.as_ref()) {
                (
                    Some(ProjectMediaPayload::Still(p) | ProjectMediaPayload::Video(p)),
                    Some(snapshot),
                ) if p.legacy_locator.is_some() => format!("sha256:{}", snapshot.sha256),
                _ => binding.source.content_identity.clone(),
            };
            let resource = VerifiedResource::new(
                ResourceKind::MediaSource,
                ResourceDescriptor::MediaSource(MediaSourceDescriptor {
                    source_id: CompositionIdentity::Unicode(source_id.clone()),
                    content_identity,
                    authorization_scope: scope.to_owned(),
                    media_kind: kind,
                }),
                vec![],
            )?;
            let mut info = ProjectMediaSourceInfo {
                kind,
                width: 0,
                height: 0,
                duration: None,
            };
            if kind != MediaKind::Video {
                let dimensions = [binding.source.width.value(), binding.source.height.value()];
                let mut extent = [0_u32; 2];
                for (index, dimension) in dimensions.into_iter().enumerate() {
                    let value = dimension
                        .and_then(|n| n.as_f64())
                        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 1.0 && *n <= 16384.0)
                        .ok_or_else(|| {
                            MediaError::Unsupported("bounded image dimensions required".into())
                        })?;
                    extent[index] = value as u32;
                }
                [info.width, info.height] = extent;
            }
            let members = match binding.payload.as_deref() {
                Some(ProjectMediaPayload::ImageSequence(sequence)) => {
                    info.duration = Some(
                        (sequence.end_frame - sequence.start_frame + 1) as f64
                            * sequence.frame_rate.denominator as f64
                            / sequence.frame_rate.numerator as f64,
                    );
                    sequence
                        .frames
                        .iter()
                        .map(|f| Some(f.frame))
                        .collect::<Vec<_>>()
                }
                _ => vec![None],
            };
            let mut identities = BTreeMap::new();
            for member in members {
                if cancellation.is_cancelled() {
                    return Err(aster_video::FfmpegError::Cancelled.into());
                }
                let bytes = match ordinary.take() {
                    Some(snapshot) => snapshot,
                    None => binding.read(reader, member, maximum)?,
                };
                if let Some(frame) = member {
                    identities.insert(frame, bytes.byte_identity.clone());
                }
                if let Some(path) = bytes.path {
                    files.push(StillAuthorization {
                        source: resource.request().hash.clone(),
                        sequence_frame: member,
                        scope: scope.to_owned(),
                        path,
                        sha256: bytes.sha256,
                    });
                } else {
                    snapshots.push(MediaSnapshotAuthorization {
                        source: resource.request().hash.clone(),
                        sequence_frame: member,
                        scope: scope.to_owned(),
                        bytes: bytes.bytes.into(),
                        sha256: bytes.sha256,
                    });
                }
            }
            registry.put_verified(resource.clone())?;
            sources.insert(
                source_id,
                ProjectSource {
                    binding,
                    resource,
                    info,
                    members: identities,
                },
            );
        }
        self.decoder
            .admit_grants(files, snapshots, limits.snapshots.clone())?;
        for source in sources
            .values_mut()
            .filter(|s| s.info.kind == MediaKind::Video)
        {
            let metadata = self.decoder.inspect_source(
                &source.resource.request().hash,
                &registry,
                cancellation,
            )?;
            if !metadata.duration_seconds.is_finite() || metadata.duration_seconds <= 0.0 {
                return Err(MediaError::Unsupported(
                    "positive finite video duration required".into(),
                ));
            }
            source.info.width = metadata.width;
            source.info.height = metadata.height;
            source.info.duration = Some(metadata.duration_seconds);
        }
        self.sources.extend(sources);
        Ok(())
    }
}
