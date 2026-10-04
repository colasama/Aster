use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{ElementType, FramePlanSliceV1, IrError, ResourceDescriptor, canonical::CanonicalJson};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq, PartialOrd, Ord)]
#[serde(transparent)]
pub struct ResourceHash(#[schemars(regex(pattern = "^[0-9a-f]{64}$"))] pub String);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    Buffer,
    MediaSource,
    MediaFrame,
    RasterPixels,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BufferResourceDescriptor {
    pub element_type: ElementType,
    #[schemars(range(min = 1))]
    pub element_count: u32,
    #[schemars(range(min = 1))]
    pub byte_length: u32,
}

impl BufferResourceDescriptor {
    pub fn validate(&self, bytes: &[u8]) -> Result<(), IrError> {
        if self.element_count == 0
            || self
                .element_count
                .checked_mul(self.element_type.byte_width())
                .ok_or(IrError::ArithmeticOverflow)?
                != self.byte_length
            || bytes.len() != self.byte_length as usize
        {
            return Err(IrError::ElementCountMismatch);
        }
        Ok(())
    }
}

#[derive(Serialize)]
struct ResourceIdentity {
    kind: ResourceKind,
    descriptor: ResourceDescriptor,
}

impl ResourceHash {
    pub fn validate(&self) -> Result<(), IrError> {
        if self.0.len() != 64
            || !self
                .0
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(IrError::InvalidResource(
                "SHA-256 must be 64 lowercase hexadecimal characters".to_owned(),
            ));
        }
        Ok(())
    }

    pub fn for_buffer(
        descriptor: &BufferResourceDescriptor,
        bytes: &[u8],
    ) -> Result<Self, IrError> {
        Self::for_resource(
            ResourceKind::Buffer,
            &ResourceDescriptor::Buffer(descriptor.clone()),
            bytes,
        )
    }

    pub fn for_resource(
        kind: ResourceKind,
        descriptor: &ResourceDescriptor,
        bytes: &[u8],
    ) -> Result<Self, IrError> {
        descriptor.validate(kind, bytes)?;
        let identity = ResourceIdentity {
            kind,
            descriptor: descriptor.clone(),
        };
        let canonical = CanonicalJson::encode(&identity)?;
        let length = u32::try_from(canonical.len()).map_err(|_| IrError::ArithmeticOverflow)?;
        let mut digest = Sha256::new();
        digest.update(b"ASTER_RESOURCE_V1\0");
        digest.update(length.to_le_bytes());
        digest.update(canonical);
        digest.update(bytes);
        Ok(Self(format!("{:x}", digest.finalize())))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PutResource {
    pub hash: ResourceHash,
    pub kind: ResourceKind,
    pub descriptor: ResourceDescriptor,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResourceMessage {
    PutResource(PutResource),
    EvictResource { hash: ResourceHash },
}

#[derive(Clone, Debug)]
pub struct ResourceLimits {
    pub budget_bytes: u64,
    pub max_resources: usize,
    pub max_leases: usize,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            budget_bytes: 512 * 1024 * 1024,
            max_resources: 65_536,
            max_leases: 4096,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PutOutcome {
    Inserted,
    AlreadyPresent,
}

#[derive(Debug)]
pub struct ResourceLease {
    id: u64,
    owner: Arc<()>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ResourceStatistics {
    pub budget_bytes: u64,
    pub used_bytes: u64,
    pub resources: usize,
    pub active_leases: usize,
}

struct ResourceEntry {
    descriptor: ResourceDescriptor,
    bytes: Vec<u8>,
    pins: usize,
    accounted_bytes: u64,
}

pub struct ResourceRegistry {
    limits: ResourceLimits,
    entries: BTreeMap<ResourceHash, ResourceEntry>,
    raster_pixels: BTreeMap<ResourceHash, ResourceHash>,
    leases: BTreeMap<u64, Vec<ResourceHash>>,
    next_lease: u64,
    used_bytes: u64,
    identity: Arc<()>,
}

impl ResourceRegistry {
    pub fn new(limits: ResourceLimits) -> Result<Self, IrError> {
        if limits.budget_bytes > 9_007_199_254_740_991
            || limits.max_resources == 0
            || limits.max_resources > u32::MAX as usize
            || limits.max_leases == 0
            || limits.max_leases > u32::MAX as usize
        {
            return Err(IrError::LimitExceeded(
                "invalid resource registry limits".to_owned(),
            ));
        }
        Ok(Self {
            limits,
            entries: BTreeMap::new(),
            raster_pixels: BTreeMap::new(),
            leases: BTreeMap::new(),
            next_lease: 0,
            used_bytes: 0,
            identity: Arc::new(()),
        })
    }

    pub fn put(&mut self, request: PutResource, bytes: Vec<u8>) -> Result<PutOutcome, IrError> {
        request.hash.validate()?;
        request.descriptor.validate(request.kind, &bytes)?;
        if ResourceHash::for_resource(request.kind, &request.descriptor, &bytes)? != request.hash {
            return Err(IrError::HashMismatch);
        }
        if let Some(existing) = self.entries.get(&request.hash) {
            if existing.descriptor != request.descriptor || existing.bytes != bytes {
                return Err(IrError::ResourceConflict);
            }
            return Ok(PutOutcome::AlreadyPresent);
        }
        let requested = u64::try_from(match &request.descriptor {
            ResourceDescriptor::Buffer(_) | ResourceDescriptor::RasterPixels(_) => bytes.len(),
            _ => CanonicalJson::encode(&request.descriptor)?.len(),
        })
        .map_err(|_| IrError::ArithmeticOverflow)?;
        let total = self
            .used_bytes
            .checked_add(requested)
            .ok_or(IrError::ArithmeticOverflow)?;
        if total > self.limits.budget_bytes {
            return Err(IrError::ResourceBudgetExceeded {
                used: self.used_bytes,
                requested,
                budget: self.limits.budget_bytes,
            });
        }
        if self.entries.len() >= self.limits.max_resources {
            return Err(IrError::LimitExceeded("resource count".to_owned()));
        }
        if let ResourceDescriptor::MediaFrame(frame) = &request.descriptor {
            let source = self
                .entries
                .get_mut(&frame.source)
                .ok_or_else(|| IrError::MissingResource(frame.source.0.clone()))?;
            let ResourceDescriptor::MediaSource(descriptor) = &source.descriptor else {
                return Err(IrError::ResourceConflict);
            };
            frame.validate_source(descriptor)?;
            source.pins += 1;
        }
        if let ResourceDescriptor::RasterPixels(pixels) = &request.descriptor {
            if self.raster_pixels.contains_key(&pixels.frame) {
                return Err(IrError::ResourceConflict);
            }
            let frame = self
                .entries
                .get_mut(&pixels.frame)
                .ok_or_else(|| IrError::MissingResource(pixels.frame.0.clone()))?;
            let ResourceDescriptor::MediaFrame(descriptor) = &frame.descriptor else {
                return Err(IrError::ResourceConflict);
            };
            pixels.validate_frame(descriptor)?;
            frame.pins += 1;
            self.raster_pixels
                .insert(pixels.frame.clone(), request.hash.clone());
        }
        self.entries.insert(
            request.hash,
            ResourceEntry {
                descriptor: request.descriptor,
                bytes,
                pins: 0,
                accounted_bytes: requested,
            },
        );
        self.used_bytes = total;
        Ok(PutOutcome::Inserted)
    }

    pub fn resolve(&self, hash: &ResourceHash) -> Result<&[u8], IrError> {
        hash.validate()?;
        let resource = self
            .entries
            .get(hash)
            .ok_or_else(|| IrError::MissingResource(hash.0.clone()))?;
        Ok(&resource.bytes)
    }

    pub fn descriptor(&self, hash: &ResourceHash) -> Result<&ResourceDescriptor, IrError> {
        hash.validate()?;
        self.entries
            .get(hash)
            .map(|entry| &entry.descriptor)
            .ok_or_else(|| IrError::MissingResource(hash.0.clone()))
    }

    pub fn validate_references(&self, plan: &FramePlanSliceV1) -> Result<(), IrError> {
        for hash in &plan.resources {
            self.resolve(hash)?;
        }
        Ok(())
    }

    pub fn pin(&mut self, hashes: &[ResourceHash]) -> Result<ResourceLease, IrError> {
        if hashes.len() > self.limits.max_resources
            || hashes.iter().collect::<BTreeSet<_>>().len() != hashes.len()
        {
            return Err(IrError::InvalidResource(
                "a lease requires unique resource hashes within the count limit".to_owned(),
            ));
        }
        if self.leases.len() >= self.limits.max_leases {
            return Err(IrError::LimitExceeded("active resource leases".to_owned()));
        }
        let id = self
            .next_lease
            .checked_add(1)
            .filter(|id| *id <= 9_007_199_254_740_991)
            .ok_or(IrError::ArithmeticOverflow)?;
        for hash in hashes {
            hash.validate()?;
            let entry = self
                .entries
                .get(hash)
                .ok_or_else(|| IrError::MissingResource(hash.0.clone()))?;
            entry
                .pins
                .checked_add(1)
                .ok_or(IrError::ArithmeticOverflow)?;
        }
        for hash in hashes {
            let entry = self
                .entries
                .get_mut(hash)
                .ok_or_else(|| IrError::MissingResource(hash.0.clone()))?;
            entry.pins += 1;
        }
        self.leases.insert(id, hashes.to_vec());
        self.next_lease = id;
        Ok(ResourceLease {
            id,
            owner: Arc::clone(&self.identity),
        })
    }

    pub fn release(&mut self, lease: &ResourceLease) -> Result<(), IrError> {
        if !Arc::ptr_eq(&lease.owner, &self.identity) {
            return Err(IrError::InvalidLease);
        }
        let Some(hashes) = self.leases.get(&lease.id) else {
            return Ok(());
        };
        for hash in hashes {
            if self.entries.get(hash).is_none_or(|entry| entry.pins == 0) {
                return Err(IrError::InvalidLease);
            }
        }
        for hash in hashes {
            let entry = self.entries.get_mut(hash).ok_or(IrError::InvalidLease)?;
            entry.pins -= 1;
        }
        self.leases.remove(&lease.id);
        Ok(())
    }

    pub fn evict(&mut self, hash: &ResourceHash) -> Result<(), IrError> {
        hash.validate()?;
        let entry = self
            .entries
            .get(hash)
            .ok_or_else(|| IrError::MissingResource(hash.0.clone()))?;
        if entry.pins != 0 {
            return Err(IrError::ResourceInUse(hash.0.clone()));
        }
        let used = self
            .used_bytes
            .checked_sub(entry.accounted_bytes)
            .ok_or(IrError::ArithmeticOverflow)?;
        let dependency = match &entry.descriptor {
            ResourceDescriptor::MediaFrame(frame) => Some(frame.source.clone()),
            ResourceDescriptor::RasterPixels(pixels) => Some(pixels.frame.clone()),
            _ => None,
        };
        if let ResourceDescriptor::RasterPixels(pixels) = &entry.descriptor {
            self.raster_pixels.remove(&pixels.frame);
        }
        if let Some(source) = dependency {
            let source = self.entries.get_mut(&source).ok_or(IrError::InvalidLease)?;
            source.pins = source.pins.checked_sub(1).ok_or(IrError::InvalidLease)?;
        }
        self.entries.remove(hash);
        self.used_bytes = used;
        Ok(())
    }

    pub fn statistics(&self) -> ResourceStatistics {
        ResourceStatistics {
            budget_bytes: self.limits.budget_bytes,
            used_bytes: self.used_bytes,
            resources: self.entries.len(),
            active_leases: self.leases.len(),
        }
    }
}
