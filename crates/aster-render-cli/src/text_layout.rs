use std::{collections::BTreeMap, fs::File, io::Read, path::PathBuf, process::ExitCode};

use aster_text::{
    FontCatalog, FontCatalogConfig, FontDiscoveryConfig, FontRequest, FontStyle, NativeFont,
    ShapedText, TextDirection, TextLayout, TextLayoutRequest, TextLayoutResult, TextShapeConfig,
    TextShaper,
};
use clap::Args;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    ir::IrArgs,
    text_raster::{RasterAudit, RasterReport},
};

#[derive(Debug, Args)]
pub(crate) struct TextLayoutArgs {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    out: PathBuf,
    #[arg(long, default_value_t = 64 * 1024 * 1024)]
    max_input_bytes: u64,
    #[arg(long, default_value_t = 25_000)]
    max_requests: usize,
    #[arg(long, default_value_t = 128 * 1024 * 1024)]
    max_output_bytes: usize,
    #[command(flatten)]
    discovery: FontDiscoveryConfig,
    #[command(flatten)]
    catalog: FontCatalogConfig,
    #[command(flatten)]
    shaping: TextShapeConfig,
    #[arg(long)]
    rasterize: bool,
    #[command(flatten)]
    raster: aster_text::GlyphRasterConfig,
    #[command(flatten)]
    atlas: aster_text::GlyphGenerationConfig,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct FontInput {
    families: Vec<String>,
    weight: u16,
    italic: bool,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum LayoutQuery {
    Shape {
        text: String,
        size: f64,
        direction: TextDirection,
        language: String,
    },
    Layout {
        request: TextLayoutRequest,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LayoutInput {
    id: String,
    font: FontInput,
    query: LayoutQuery,
}

#[derive(Serialize)]
struct FontEvidence {
    path: PathBuf,
    sha256: String,
    faces: usize,
    error: Option<String>,
}

#[derive(Serialize)]
struct LayoutOutput {
    id: String,
    shaped: Option<ShapedText>,
    layout: Option<TextLayoutResult>,
    error: Option<String>,
}

#[derive(Serialize)]
struct LayoutReport {
    schema_version: u32,
    input_sha256: String,
    fonts: Vec<FontEvidence>,
    results: Vec<LayoutOutput>,
    native_raster: bool,
    raster_components: Option<RasterReport>,
}

impl TextLayoutArgs {
    pub fn run(self) -> Result<ExitCode, Box<dyn std::error::Error>> {
        if self.max_input_bytes == 0
            || self.max_input_bytes > 256 * 1024 * 1024
            || self.max_requests == 0
            || self.max_requests > 100_000
            || self.max_output_bytes == 0
            || self.max_output_bytes > 512 * 1024 * 1024
        {
            return Err("Invalid text diagnostic budgets".into());
        }
        let mut bytes = Vec::new();
        File::open(&self.input)?
            .take(self.max_input_bytes + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > self.max_input_bytes {
            return Err("Text request input exceeds budget".into());
        }
        let inputs: Vec<LayoutInput> = serde_json::from_slice(&bytes)?;
        if inputs.is_empty() || inputs.len() > self.max_requests {
            return Err("Text request count exceeds budget".into());
        }
        let requested_families: std::collections::BTreeSet<_> = inputs
            .iter()
            .flat_map(|input| input.font.families.iter())
            .map(|family| {
                match family.as_str() {
                    "sans-serif" if cfg!(windows) => "Arial",
                    "serif" if cfg!(windows) => "Times New Roman",
                    "monospace" if cfg!(windows) => "Courier New",
                    value => value,
                }
                .to_owned()
            })
            .collect();
        if requested_families.len() > 256 {
            return Err("Requested font family inventory exceeds budget".into());
        }
        let family_probe = FontRequest {
            families: requested_families.into_iter().collect(),
            weight: 400.0,
            width_percent: 100.0,
            style: FontStyle::Normal,
        };
        let mut catalog = FontCatalog::new(self.catalog.clone())?;
        let mut evidence = Vec::new();
        for file in self.discovery.discover(
            FontDiscoveryConfig::platform_roots(),
            self.discovery.max_discovery_files,
        )? {
            let loaded = file.load(&self.discovery)?;
            let sha256 = format!("{:x}", Sha256::digest(&loaded.data));
            let mut candidate = FontCatalog::new(FontCatalogConfig {
                max_catalog_bytes: self.discovery.max_font_bytes,
                ..self.catalog.clone()
            })?;
            let result = candidate.insert(loaded.clone()).and_then(|_| {
                if candidate.select(&family_probe)?.is_some() {
                    catalog.insert(loaded)
                } else {
                    Ok(Vec::new())
                }
            });
            evidence.push(FontEvidence {
                path: file.path,
                sha256,
                faces: result.as_ref().map_or(0, Vec::len),
                error: result.err().map(|e| e.to_string()),
            });
        }
        let shaper = TextShaper::new(self.shaping.clone())?;
        let layout = TextLayout::new(self.shaping)?;
        let mut raster = if self.rasterize {
            Some(RasterAudit::new(
                self.out
                    .parent()
                    .ok_or("Raster output parent missing")?
                    .join("glyph-rasters"),
                self.raster,
                self.atlas,
            )?)
        } else {
            None
        };
        let mut cache: BTreeMap<(Vec<String>, u16, bool), Vec<NativeFont>> = BTreeMap::new();
        let mut results = Vec::with_capacity(inputs.len());
        let mut output_bytes = 0_usize;
        for input in inputs {
            if input.id.len() > 256 {
                return Err("Text request identity exceeds budget".into());
            }
            let key = (
                input.font.families.clone(),
                input.font.weight,
                input.font.italic,
            );
            let mut output = LayoutOutput {
                id: input.id,
                shaped: None,
                layout: None,
                error: None,
            };
            if !cache.contains_key(&key) {
                if cache.len() >= 128 {
                    return Err("Text font instance cache exceeds budget".into());
                }
                let resolved = input.font.resolve(&catalog);
                match resolved {
                    Ok(fonts) => {
                        cache.insert(key.clone(), fonts);
                    }
                    Err(error) => output.error = Some(error.to_string()),
                }
            }
            if let Some(fonts) = cache.get(&key) {
                match input.query {
                    LayoutQuery::Shape {
                        text,
                        size,
                        direction,
                        language,
                    } => match shaper.shape(&text, size, direction, &language, fonts) {
                        Ok(value) => {
                            if let Some(raster) = &mut raster {
                                raster.observe(&output.id, &value, size as f32, fonts)?;
                            }
                            output.shaped = Some(value);
                        }
                        Err(error) => output.error = Some(error.to_string()),
                    },
                    LayoutQuery::Layout { request } => match layout.evaluate(&request, fonts) {
                        Ok(value) => {
                            if let Some(raster) = &mut raster {
                                for (line, row) in value.lines.iter().enumerate() {
                                    for (fragment, run) in row.fragments.iter().enumerate() {
                                        raster.observe(
                                            &format!("{}:{line}:{fragment}", output.id),
                                            &run.shaped,
                                            request.font_size as f32,
                                            fonts,
                                        )?;
                                    }
                                }
                            }
                            output.layout = Some(value);
                        }
                        Err(error) => output.error = Some(error.to_string()),
                    },
                }
            }
            output_bytes = output_bytes
                .checked_add(serde_json::to_vec(&output)?.len())
                .filter(|n| *n <= self.max_output_bytes)
                .ok_or("Text diagnostic output exceeds budget")?;
            results.push(output);
        }
        let report = LayoutReport {
            schema_version: 1,
            input_sha256: format!("{:x}", Sha256::digest(&bytes)),
            fonts: evidence,
            results,
            native_raster: false,
            raster_components: raster.map(RasterAudit::finish).transpose()?,
        };
        let json = serde_json::to_vec(&report)?;
        if json.len() > self.max_output_bytes {
            return Err("Text diagnostic output exceeds budget".into());
        }
        IrArgs::publish(&self.out, &json)?;
        Ok(ExitCode::SUCCESS)
    }
}

impl FontInput {
    fn resolve(
        &self,
        catalog: &FontCatalog,
    ) -> Result<Vec<NativeFont>, Box<dyn std::error::Error>> {
        if self.families.is_empty() || self.families.len() > 16 {
            return Err("Invalid fallback family chain".into());
        }
        let mut fonts = Vec::new();
        let style = if self.italic {
            FontStyle::Italic
        } else {
            FontStyle::Normal
        };
        for family in &self.families {
            // Generic aliases are an explicit Windows diagnostic policy, not a portable font map.
            let family = match family.as_str() {
                "sans-serif" if cfg!(windows) => "Arial",
                "serif" if cfg!(windows) => "Times New Roman",
                "monospace" if cfg!(windows) => "Courier New",
                value => value,
            };
            let Some(selection) = catalog.select(&FontRequest {
                families: vec![family.to_owned()],
                weight: f32::from(self.weight),
                width_percent: 100.0,
                style,
            })?
            else {
                continue;
            };
            if selection.style != style {
                return Err("Synthetic font style requires retained rendering".into());
            }
            if self.weight >= 600 && selection.weight < 600.0 {
                return Err("Synthetic font weight requires retained rendering".into());
            }
            let (_, loaded) = catalog
                .face(selection.face)
                .ok_or("Selected font disappeared")?;
            fonts.push(NativeFont::new(selection, loaded)?);
        }
        if fonts.is_empty() {
            return Err("Requested font families unavailable".into());
        }
        Ok(fonts)
    }
}
