use std::collections::BTreeMap;

use aster_render_ir::{EffectComposite, Extent2d, RootCommandRecord};
use serde::Serialize;

use crate::{RenderError, scene_input::SceneInput};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PixelRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct EffectRegionStatistics {
    pub isolated_passes: u64,
    pub bounded_passes: u64,
    pub full_pixels: u64,
    pub drawn_pixels: u64,
}

pub(crate) struct EffectRegions {
    pub enabled: bool,
    pub statistics: EffectRegionStatistics,
}

impl EffectRegions {
    /// The supplied vertices already contain projected clip positions with w=1. Bounds include
    /// every triangle, then expand for the admitted shader's footprint and raster/filter rounding.
    pub fn collect(&self, frame: &SceneInput) -> Result<BTreeMap<usize, PixelRegion>, RenderError> {
        let mut regions = BTreeMap::new();
        if !self.enabled {
            return Ok(regions);
        }
        let size = frame.header.render_target;
        for (start, command) in frame.root.commands.iter().enumerate() {
            let RootCommandRecord::BeginLayer { effect_blob_index } = command else {
                continue;
            };
            let plan = frame
                .layers
                .get(effect_blob_index)
                .ok_or_else(|| RenderError::Invalid("bounded layer absent".into()))?;
            if plan.composite == EffectComposite::Replace {
                continue;
            }
            let Some(padding) = crate::region_program::RegionProgram::padding(plan, size) else {
                continue;
            };
            let mut bounds = [
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            ];
            let mut complete = false;
            let mut supported = true;
            for command in frame.root.commands.iter().skip(start + 1) {
                match command {
                    RootCommandRecord::FinishLayer => {
                        complete = true;
                        break;
                    }
                    RootCommandRecord::Geometry { draw_index, .. } => {
                        let draw =
                            frame.root.draws.get(*draw_index as usize).ok_or_else(|| {
                                RenderError::Invalid("bounded draw absent".into())
                            })?;
                        if draw.material_blob_index.is_some() {
                            supported = false;
                            break;
                        }
                        let first = draw.first_vertex as usize * 160;
                        let last = first + draw.vertex_count as usize * 160;
                        let vertices = frame
                            .vertices
                            .get(first..last)
                            .ok_or_else(|| RenderError::Invalid("bounded vertex range".into()))?;
                        for vertex in vertices.chunks_exact(160) {
                            let x =
                                f32::from_le_bytes([vertex[0], vertex[1], vertex[2], vertex[3]]);
                            let y =
                                f32::from_le_bytes([vertex[4], vertex[5], vertex[6], vertex[7]]);
                            if !x.is_finite() || !y.is_finite() {
                                supported = false;
                                break;
                            }
                            let x = (f64::from(x) + 1.0) * 0.5 * f64::from(size.width);
                            let y = (1.0 - f64::from(y)) * 0.5 * f64::from(size.height);
                            bounds[0] = bounds[0].min(x);
                            bounds[1] = bounds[1].min(y);
                            bounds[2] = bounds[2].max(x);
                            bounds[3] = bounds[3].max(y);
                        }
                    }
                    _ => {
                        supported = false;
                        break;
                    }
                }
            }
            if complete && supported {
                let region = if bounds[0].is_infinite() {
                    PixelRegion {
                        x: 0,
                        y: 0,
                        width: 0,
                        height: 0,
                    }
                } else {
                    let x = (bounds[0] - padding)
                        .floor()
                        .clamp(0.0, f64::from(size.width)) as u32;
                    let y = (bounds[1] - padding)
                        .floor()
                        .clamp(0.0, f64::from(size.height)) as u32;
                    let right = (bounds[2] + padding)
                        .ceil()
                        .clamp(0.0, f64::from(size.width)) as u32;
                    let bottom = (bounds[3] + padding)
                        .ceil()
                        .clamp(0.0, f64::from(size.height)) as u32;
                    PixelRegion {
                        x,
                        y,
                        width: right.saturating_sub(x),
                        height: bottom.saturating_sub(y),
                    }
                };
                regions.insert(start, region);
            }
        }
        Ok(regions)
    }

    pub fn record(&mut self, size: Extent2d, region: Option<PixelRegion>) {
        let full = u64::from(size.width) * u64::from(size.height);
        let drawn = region.map_or(full, |r| u64::from(r.width) * u64::from(r.height));
        self.statistics.isolated_passes += 1;
        self.statistics.bounded_passes += u64::from(drawn < full);
        self.statistics.full_pixels += full;
        self.statistics.drawn_pixels += drawn;
    }
}
