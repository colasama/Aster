// Generated effect pixel-unit metadata.
use super::catalog::EffectCatalog;
use crate::PixelParameter;
impl EffectCatalog {
    pub(super) fn catalog_3(effect_type: &str) -> Option<Vec<PixelParameter>> {
        match effect_type {
            "gaussian-blur" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 18.0,
            }]),
            "kawase-blur" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 24.0,
            }]),
            "sharpen" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 1.5,
            }]),
            "curves" => Some(vec![]),
            "color-balance" => Some(vec![]),
            "color-matrix" => Some(vec![]),
            "channel-mixer" => Some(vec![]),
            "wave-warp" => Some(vec![
                PixelParameter {
                    key: "height".into(),
                    default_value: 24.0,
                },
                PixelParameter {
                    key: "width".into(),
                    default_value: 320.0,
                },
            ]),
            "chromatic" => Some(vec![PixelParameter {
                key: "amount".into(),
                default_value: 6.0,
            }]),
            "checkerboard" => Some(vec![PixelParameter {
                key: "size".into(),
                default_value: 80.0,
            }]),
            "grid" => Some(vec![
                PixelParameter {
                    key: "width".into(),
                    default_value: 120.0,
                },
                PixelParameter {
                    key: "height".into(),
                    default_value: 120.0,
                },
                PixelParameter {
                    key: "border".into(),
                    default_value: 2.0,
                },
            ]),
            "glow" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 42.0,
            }]),
            "chroma-key" => Some(vec![]),
            "spill-suppressor" => Some(vec![]),
            "split-tone" => Some(vec![]),
            "gradient-ramp" => Some(vec![]),
            "colorama" => Some(vec![]),
            "kaleidoscope" => Some(vec![]),
            "glass" => Some(vec![
                PixelParameter {
                    key: "softness".into(),
                    default_value: 2.0,
                },
                PixelParameter {
                    key: "displacement".into(),
                    default_value: 12.0,
                },
            ]),
            "cartoon" => Some(vec![]),
            "solarize" => Some(vec![]),
            "simple-choker" => Some(vec![
                PixelParameter {
                    key: "choke".into(),
                    default_value: 2.0,
                },
                PixelParameter {
                    key: "softness".into(),
                    default_value: 1.0,
                },
            ]),
            "camera-lens-blur" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 18.0,
            }]),
            "change-to-color" => Some(vec![]),
            "circle" => Some(vec![
                PixelParameter {
                    key: "radius".into(),
                    default_value: 240.0,
                },
                PixelParameter {
                    key: "thickness".into(),
                    default_value: 12.0,
                },
                PixelParameter {
                    key: "feather".into(),
                    default_value: 2.0,
                },
            ]),
            "star-burst" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 420.0,
            }]),
            "offset" => Some(vec![
                PixelParameter {
                    key: "shiftX".into(),
                    default_value: 0.0,
                },
                PixelParameter {
                    key: "shiftY".into(),
                    default_value: 0.0,
                },
            ]),
            "corner-pin" => Some(vec![]),
            "cell-pattern" => Some(vec![PixelParameter {
                key: "cellSize".into(),
                default_value: 120.0,
            }]),
            "snowfall" => Some(vec![
                PixelParameter {
                    key: "size".into(),
                    default_value: 5.0,
                },
                PixelParameter {
                    key: "turbulence".into(),
                    default_value: 24.0,
                },
            ]),
            "crop" => Some(vec![PixelParameter {
                key: "feather".into(),
                default_value: 0.0,
            }]),
            "overscan" => Some(vec![]),
            "gradient-wipe" => Some(vec![PixelParameter {
                key: "scale".into(),
                default_value: 180.0,
            }]),
            "strobe-light" => Some(vec![]),
            "scatter" => Some(vec![
                PixelParameter {
                    key: "horizontal".into(),
                    default_value: 18.0,
                },
                PixelParameter {
                    key: "vertical".into(),
                    default_value: 18.0,
                },
                PixelParameter {
                    key: "grain".into(),
                    default_value: 6.0,
                },
            ]),
            "selective-color" => Some(vec![]),
            "shadows-highlights" => Some(vec![]),
            "gamma-pedestal-gain" => Some(vec![]),
            "white-balance" => Some(vec![]),
            "color-emboss" => Some(vec![PixelParameter {
                key: "relief".into(),
                default_value: 2.0,
            }]),
            "shadow-desaturate" => Some(vec![]),
            "skin-tone-refine" => Some(vec![]),
            "set-channels" => Some(vec![]),
            "color-range" => Some(vec![]),
            "keylight" => Some(vec![]),
            "key-cleaner" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 2.0,
            }]),
            "screen-matte" => Some(vec![
                PixelParameter {
                    key: "shrinkGrow".into(),
                    default_value: 0.0,
                },
                PixelParameter {
                    key: "softness".into(),
                    default_value: 1.0,
                },
            ]),
            "core-matte" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 5.0,
            }]),
            "spill-killer" => Some(vec![]),
            "wire-removal" => Some(vec![
                PixelParameter {
                    key: "width".into(),
                    default_value: 8.0,
                },
                PixelParameter {
                    key: "feather".into(),
                    default_value: 4.0,
                },
                PixelParameter {
                    key: "sampleOffset".into(),
                    default_value: 14.0,
                },
            ]),
            "shift-channels" => Some(vec![]),
            "channel-combiner" => Some(vec![]),
            "solid-composite" => Some(vec![]),
            "set-matte" => Some(vec![]),
            "channel-blur" => Some(vec![
                PixelParameter {
                    key: "red".into(),
                    default_value: 8.0,
                },
                PixelParameter {
                    key: "green".into(),
                    default_value: 8.0,
                },
                PixelParameter {
                    key: "blue".into(),
                    default_value: 8.0,
                },
                PixelParameter {
                    key: "alpha".into(),
                    default_value: 0.0,
                },
            ]),
            "cross-blur" => Some(vec![
                PixelParameter {
                    key: "horizontal".into(),
                    default_value: 18.0,
                },
                PixelParameter {
                    key: "vertical".into(),
                    default_value: 18.0,
                },
            ]),
            "smart-blur" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 14.0,
            }]),
            "sharpen-edges" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 1.5,
            }]),
            "compound-blur" => Some(vec![PixelParameter {
                key: "maximumRadius".into(),
                default_value: 36.0,
            }]),
            "spherize" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 320.0,
            }]),
            "optics-compensation" => Some(vec![]),
            "cylinder" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 480.0,
            }]),
            "sphere" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 420.0,
            }]),
            "warp" => Some(vec![]),
            "outer-glow" => Some(vec![PixelParameter {
                key: "size".into(),
                default_value: 24.0,
            }]),
            "satin" => Some(vec![
                PixelParameter {
                    key: "distance".into(),
                    default_value: 14.0,
                },
                PixelParameter {
                    key: "size".into(),
                    default_value: 18.0,
                },
            ]),
            "color-overlay" => Some(vec![]),
            "gradient-overlay" => Some(vec![]),
            "clock-wipe" => Some(vec![]),
            "grid-wipe" => Some(vec![]),
            "scale-wipe" => Some(vec![PixelParameter {
                key: "feather".into(),
                default_value: 12.0,
            }]),
            "card-wipe" => Some(vec![]),
            "scatterize" => Some(vec![
                PixelParameter {
                    key: "scatterX".into(),
                    default_value: 80.0,
                },
                PixelParameter {
                    key: "scatterY".into(),
                    default_value: 80.0,
                },
                PixelParameter {
                    key: "grain".into(),
                    default_value: 48.0,
                },
            ]),
            "wave-world" => Some(vec![]),
            "color-halftone" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 8.0,
            }]),
            "glowing-edges" => Some(vec![PixelParameter {
                key: "width".into(),
                default_value: 1.5,
            }]),
            "cc-threshold" => Some(vec![]),
            "cc-toner" => Some(vec![]),
            "cc-plastic" => Some(vec![PixelParameter {
                key: "softness".into(),
                default_value: 3.0,
            }]),
            "cc-blobbylize" => Some(vec![PixelParameter {
                key: "softness".into(),
                default_value: 18.0,
            }]),
            "spotlight" => Some(vec![]),
            "caustics" => Some(vec![PixelParameter {
                key: "scale".into(),
                default_value: 90.0,
            }]),
            "god-rays" => Some(vec![]),
            "gamut-compressor" => Some(vec![]),
            "gamut-warning" => Some(vec![]),
            "scanlines" => Some(vec![
                PixelParameter {
                    key: "spacing".into(),
                    default_value: 4.0,
                },
                PixelParameter {
                    key: "width".into(),
                    default_value: 1.0,
                },
            ]),
            "compression-blocks" => Some(vec![PixelParameter {
                key: "blockSize".into(),
                default_value: 16.0,
            }]),
            "gate-weave" => Some(vec![
                PixelParameter {
                    key: "horizontal".into(),
                    default_value: 4.0,
                },
                PixelParameter {
                    key: "vertical".into(),
                    default_value: 3.0,
                },
            ]),
            "griddler" => Some(vec![
                PixelParameter {
                    key: "tileWidth".into(),
                    default_value: 160.0,
                },
                PixelParameter {
                    key: "tileHeight".into(),
                    default_value: 160.0,
                },
                PixelParameter {
                    key: "offsetX".into(),
                    default_value: 0.0,
                },
                PixelParameter {
                    key: "offsetY".into(),
                    default_value: 0.0,
                },
            ]),
            "slant" => Some(vec![]),
            "smear" => Some(vec![
                PixelParameter {
                    key: "radius".into(),
                    default_value: 180.0,
                },
                PixelParameter {
                    key: "feather".into(),
                    default_value: 60.0,
                },
            ]),
            "split" => Some(vec![
                PixelParameter {
                    key: "distance".into(),
                    default_value: 80.0,
                },
                PixelParameter {
                    key: "feather".into(),
                    default_value: 12.0,
                },
            ]),
            "stroke" => Some(vec![
                PixelParameter {
                    key: "width".into(),
                    default_value: 14.0,
                },
                PixelParameter {
                    key: "feather".into(),
                    default_value: 3.0,
                },
            ]),
            "scribble" => Some(vec![
                PixelParameter {
                    key: "spacing".into(),
                    default_value: 32.0,
                },
                PixelParameter {
                    key: "width".into(),
                    default_value: 3.0,
                },
                PixelParameter {
                    key: "wiggle".into(),
                    default_value: 12.0,
                },
            ]),
            "write-on" => Some(vec![
                PixelParameter {
                    key: "width".into(),
                    default_value: 18.0,
                },
                PixelParameter {
                    key: "feather".into(),
                    default_value: 4.0,
                },
            ]),
            "clarity" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 12.0,
            }]),
            "smart-sharpen" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 1.4,
            }]),
            _ => None,
        }
    }
}
