use crate::ir::IrArgs;
use aster_eval::{
    BundleLimits, BundleMediaPixels, BundleResources, FrameOutputContext, FramePlanRequest,
    FrameSceneInputs, GeneratorDefinition, GeneratorDeviceLimits, GeneratorProgramSource,
    MaterialResources, ProjectFrameResources, SurfaceLimits, SurfaceRequest, TemporalRasterPass,
};
use aster_render_ir::{
    DecodeLimits, PrecompositionGeneratorExecution, ResourceHash, ResourceMessage, VerifiedResource,
};
use serde::Deserialize;
use std::{collections::BTreeMap, path::Path};

/// Resource observations are input evidence, not evaluator-generated GPU allocation claims.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PlanRequest {
    pub frame: FramePlanRequest,
    pub scene: FrameSceneInputs,
    pub output: FrameOutputContext,
    pub surface: SurfaceRequest,
    pub generator_device: GeneratorDeviceLimits,
    pub effect_mip_levels: u32,
    pub shadow_map_size: u32,
    #[serde(default)]
    pub media: BTreeMap<String, Option<ResourceHash>>,
    pub materials: Option<MaterialResources>,
    #[serde(default)]
    pub temporal: Vec<TemporalRasterPass>,
    pub audio: Option<Vec<u32>>,
    #[serde(default)]
    pub pixels: Vec<PixelLink>,
    #[serde(default)]
    pub generators: Vec<GeneratorSource>,
    #[serde(default)]
    pub generator_observations: Vec<GeneratorObservation>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GeneratorSource {
    pub definition: GeneratorDefinition,
    pub source: GeneratorProgramSource,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GeneratorObservation {
    pub plan_sha256: ResourceHash,
    pub execution: PrecompositionGeneratorExecution,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PixelLink {
    frame: ResourceHash,
    pixels: ResourceHash,
}

impl PlanRequest {
    pub fn resources(
        &self,
        packets: Vec<VerifiedResource>,
        surface_limits: SurfaceLimits,
    ) -> Result<ProjectFrameResources, Box<dyn std::error::Error>> {
        let lookup: BTreeMap<_, _> = packets
            .iter()
            .map(|p| (p.request().hash.clone(), p.clone()))
            .collect();
        let mut pixels = Vec::new();
        for link in &self.pixels {
            link.frame.validate()?;
            pixels.push(BundleMediaPixels {
                frame: link.frame.clone(),
                pixels: lookup
                    .get(&link.pixels)
                    .cloned()
                    .ok_or("missing media pixels")?,
            });
        }
        Ok(ProjectFrameResources {
            media: self.media.clone(),
            materials: self.materials.clone(),
            packets,
            pixels,
            temporal: self.temporal.clone(),
            audio: self.audio.clone(),
            generator_device: self.generator_device.clone(),
            surface_request: self.surface.clone(),
            surface_limits,
            output: self.output.clone(),
            effect_mip_levels: self.effect_mip_levels,
            shadow_map_size: self.shadow_map_size,
        })
    }

    pub fn load_packets(
        manifest: Option<&Path>,
        directory: Option<&Path>,
        limits: &DecodeLimits,
        budget: BundleLimits,
    ) -> Result<Vec<VerifiedResource>, Box<dyn std::error::Error>> {
        let (manifest, directory) = match (manifest, directory) {
            (None, None) => return Ok(Vec::new()),
            (Some(manifest), Some(directory)) => (manifest, directory),
            _ => {
                return Err(
                    "resource manifest and payload directory must be supplied together".into(),
                );
            }
        };
        let messages: Vec<ResourceMessage> =
            serde_json::from_slice(&IrArgs::read_bounded(manifest, limits)?)?;
        if messages.len() > budget.max_bundle_resources {
            return Err("input resource count exceeds budget".into());
        }
        let mut resources = BundleResources::new(budget.clone())?;
        let mut packets = BTreeMap::new();
        let mut total = 0usize;
        for message in messages {
            let ResourceMessage::PutResource(message) = message else {
                return Err("resource manifest contains eviction".into());
            };
            message.hash.validate()?;
            if packets.contains_key(&message.hash) {
                return Err("duplicate input resource".into());
            }
            let remaining = budget
                .max_bundle_bytes
                .checked_sub(total)
                .ok_or("resource budget overflow")?;
            let maximum = limits.max_container_bytes.min(remaining.max(32));
            let input_limits = DecodeLimits {
                max_container_bytes: maximum,
                max_metadata_bytes: limits.max_metadata_bytes.min(maximum),
                ..limits.clone()
            };
            let bytes = IrArgs::read_bounded(
                &directory.join(format!("{}.bin", message.hash.0)),
                &input_limits,
            )?;
            total = total
                .checked_add(bytes.len())
                .ok_or("resource budget overflow")?;
            if total > budget.max_bundle_bytes {
                return Err("input resource bytes exceed budget".into());
            }
            let resource = VerifiedResource::new(message.kind, message.descriptor, bytes)?;
            if resource.request().hash != message.hash {
                return Err("input resource hash mismatch".into());
            }
            resources.add(resource.clone())?;
            packets.insert(message.hash, resource);
        }
        Ok(packets.into_values().collect())
    }
}
