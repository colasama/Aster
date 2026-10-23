use crate::{EvaluationError, NativePlan};
use aster_render_ir::{
    ContractLevel, DecodeLimits, ElementType, MediaTextureFormat, PrecompositionMediaPixels,
    ResourceDescriptor, ResourceHash, ResourceKind, VerifiedResource,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, clap::Args)]
pub struct BundleLimits {
    #[arg(long, default_value_t = Self::default().max_bundle_resources)]
    pub max_bundle_resources: usize,
    #[arg(long, default_value_t = Self::default().max_bundle_bytes)]
    pub max_bundle_bytes: usize,
}
impl Default for BundleLimits {
    fn default() -> Self {
        Self {
            max_bundle_resources: 65536,
            max_bundle_bytes: 67108864,
        }
    }
}

/// Immutable content proofs are admitted before any bundle is published.
pub struct BundleResources {
    entries: BTreeMap<ResourceHash, VerifiedResource>,
    used: BTreeSet<ResourceHash>,
    bytes: usize,
    limits: BundleLimits,
}
impl BundleResources {
    pub fn new(limits: BundleLimits) -> Result<Self, EvaluationError> {
        if limits.max_bundle_resources == 0
            || limits.max_bundle_resources > 65536
            || limits.max_bundle_bytes == 0
            // Bundles may carry separately admitted decoded pixels as well as plan descriptors.
            || limits.max_bundle_bytes > 1_073_741_824
        {
            return Err(EvaluationError::InvalidScene(
                "invalid bundle resource limits".into(),
            ));
        }
        Ok(Self {
            entries: BTreeMap::new(),
            used: BTreeSet::new(),
            bytes: 0,
            limits,
        })
    }
    pub fn add(&mut self, resource: VerifiedResource) -> Result<ResourceHash, EvaluationError> {
        let hash = resource.request().hash.clone();
        if self.entries.contains_key(&hash) {
            return Ok(hash);
        }
        let bytes = self
            .bytes
            .checked_add(resource.bytes().len())
            .ok_or_else(|| EvaluationError::InvalidScene("bundle resource byte overflow".into()))?;
        if self.entries.len() >= self.limits.max_bundle_resources
            || bytes > self.limits.max_bundle_bytes
        {
            return Err(EvaluationError::InvalidScene(
                "bundle resource budget exceeded".into(),
            ));
        }
        self.entries.insert(hash.clone(), resource);
        self.bytes = bytes;
        Ok(hash)
    }
    /// Resolve transitive media-source identity without marking a partial dependency set.
    fn dependencies(
        &self,
        hashes: &[ResourceHash],
    ) -> Result<BTreeSet<ResourceHash>, EvaluationError> {
        let mut dependencies = BTreeSet::new();
        for hash in hashes {
            let resource = self.entries.get(hash).ok_or_else(|| {
                EvaluationError::InvalidScene(format!("missing bundle resource {}", hash.0))
            })?;
            dependencies.insert(hash.clone());
            if let ResourceDescriptor::MediaFrame(frame) = &resource.request().descriptor {
                let source = self.entries.get(&frame.source).ok_or_else(|| {
                    EvaluationError::InvalidScene("missing bundle media source".into())
                })?;
                if source.request().kind != ResourceKind::MediaSource {
                    return Err(EvaluationError::InvalidScene(
                        "bundle media source has wrong kind".into(),
                    ));
                }
                dependencies.insert(frame.source.clone());
            }
        }
        Ok(dependencies)
    }
    pub fn require(&mut self, hashes: &[ResourceHash]) -> Result<(), EvaluationError> {
        let dependencies = self.dependencies(hashes)?;
        self.used.extend(dependencies);
        Ok(())
    }
    pub fn add_plan(
        &mut self,
        plan: &NativePlan,
        contract: ContractLevel,
    ) -> Result<ResourceHash, EvaluationError> {
        if plan.metadata.contract_level != contract {
            return Err(EvaluationError::InvalidScene(
                "bundle plan contract differs".into(),
            ));
        }
        let mut dependencies = self.dependencies(&plan.metadata.resources)?;
        let resource = VerifiedResource::from_plan(
            plan.metadata.clone(),
            &plan.blobs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
            &DecodeLimits::default(),
        )
        .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        let hash = self.add(resource)?;
        dependencies.insert(hash.clone());
        self.used.extend(dependencies);
        Ok(hash)
    }
    pub fn add_media_pixels(
        &mut self,
        frame: &ResourceHash,
        pixels: VerifiedResource,
    ) -> Result<PrecompositionMediaPixels, EvaluationError> {
        let source = self
            .entries
            .get(frame)
            .filter(|_| self.used.contains(frame))
            .ok_or_else(|| {
                EvaluationError::InvalidScene("captured media frame is unused".into())
            })?;
        let ResourceDescriptor::MediaFrame(descriptor) = &source.request().descriptor else {
            return Err(EvaluationError::InvalidScene(
                "captured media identity has wrong kind".into(),
            ));
        };
        if descriptor.format != MediaTextureFormat::Rgba8UnormSrgb
            || !matches!(&pixels.request().descriptor, ResourceDescriptor::Buffer(buffer) if buffer.element_type == ElementType::U8)
            || pixels.bytes().len() as u64
                != u64::from(descriptor.width) * u64::from(descriptor.height) * 4
            || pixels.bytes().len() > 67108864
        {
            return Err(EvaluationError::InvalidScene(
                "media pixels differ from their frame layout".into(),
            ));
        }
        let hash = self.add(pixels)?;
        self.used.insert(hash.clone());
        Ok(PrecompositionMediaPixels {
            frame: frame.clone(),
            pixels: hash,
        })
    }
    pub fn finish(self) -> Vec<VerifiedResource> {
        self.entries
            .into_iter()
            .filter_map(|(hash, resource)| self.used.contains(&hash).then_some(resource))
            .collect()
    }
}
