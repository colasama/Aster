// Generated effect pixel-unit metadata.
use super::catalog::EffectCatalog;
use crate::PixelParameter;
impl EffectCatalog {
    pub(super) fn catalog_0(effect_type: &str) -> Option<Vec<PixelParameter>> {
        match effect_type {
            "directional-blur" => Some(vec![PixelParameter {
                key: "length".into(),
                default_value: 24.0,
            }]),
            "hue-saturation" => Some(vec![]),
            "levels" => Some(vec![]),
            "tint" => Some(vec![]),
            "displacement-map" => Some(vec![
                PixelParameter {
                    key: "horizontal".into(),
                    default_value: 25.0,
                },
                PixelParameter {
                    key: "vertical".into(),
                    default_value: 25.0,
                },
            ]),
            "turbulent-displace" => Some(vec![
                PixelParameter {
                    key: "amount".into(),
                    default_value: 50.0,
                },
                PixelParameter {
                    key: "size".into(),
                    default_value: 100.0,
                },
            ]),
            "twirl" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 280.0,
            }]),
            "transform" => Some(vec![
                PixelParameter {
                    key: "positionX".into(),
                    default_value: 0.0,
                },
                PixelParameter {
                    key: "positionY".into(),
                    default_value: 0.0,
                },
            ]),
            "posterize" => Some(vec![]),
            "luma-key" => Some(vec![]),
            "posterize-time" => Some(vec![]),
            "linear-wipe" => Some(vec![
                PixelParameter {
                    key: "feather".into(),
                    default_value: 0.0,
                },
                PixelParameter {
                    key: "bend".into(),
                    default_value: 0.0,
                },
                PixelParameter {
                    key: "bendWidth".into(),
                    default_value: 1600.0,
                },
            ]),
            "particle-world" => Some(vec![]),
            "looks-color-lab" => Some(vec![]),
            "lut" => Some(vec![]),
            "threshold" => Some(vec![]),
            "drop-shadow" => Some(vec![
                PixelParameter {
                    key: "distance".into(),
                    default_value: 24.0,
                },
                PixelParameter {
                    key: "softness".into(),
                    default_value: 18.0,
                },
            ]),
            "tritone" => Some(vec![]),
            "lens-distortion" => Some(vec![]),
            "light-sweep" => Some(vec![PixelParameter {
                key: "width".into(),
                default_value: 120.0,
            }]),
            "leave-color" => Some(vec![]),
            "light-burst" => Some(vec![PixelParameter {
                key: "rayLength".into(),
                default_value: 160.0,
            }]),
            "hex-tile" => Some(vec![PixelParameter {
                key: "tileSize".into(),
                default_value: 64.0,
            }]),
            "polar-coordinates" => Some(vec![]),
            "lens-flare" => Some(vec![PixelParameter {
                key: "scale".into(),
                default_value: 180.0,
            }]),
            "letterbox" => Some(vec![PixelParameter {
                key: "feather".into(),
                default_value: 0.0,
            }]),
            "photo-filter" => Some(vec![]),
            "hdr-compander" => Some(vec![]),
            "printer-lights" => Some(vec![]),
            "hue-vs-hue" => Some(vec![]),
            "hue-vs-saturation" => Some(vec![]),
            "luma-vs-saturation" => Some(vec![]),
            "highlight-tint" => Some(vec![]),
            "linear-color-key" => Some(vec![]),
            "despot" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 3.0,
            }]),
            "premultiply-color" => Some(vec![]),
            "hdr-clamp" => Some(vec![]),
            "high-pass" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 8.0,
            }]),
            "page-turn" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 90.0,
            }]),
            "dust-scratches" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 3.0,
            }]),
            "turbulent-noise" => Some(vec![PixelParameter {
                key: "scale".into(),
                default_value: 180.0,
            }]),
            "light-wipe" => Some(vec![
                PixelParameter {
                    key: "width".into(),
                    default_value: 80.0,
                },
                PixelParameter {
                    key: "feather".into(),
                    default_value: 12.0,
                },
            ]),
            "line-sweep" => Some(vec![
                PixelParameter {
                    key: "width".into(),
                    default_value: 12.0,
                },
                PixelParameter {
                    key: "feather".into(),
                    default_value: 8.0,
                },
            ]),
            "twister" => Some(vec![
                PixelParameter {
                    key: "radius".into(),
                    default_value: 640.0,
                },
                PixelParameter {
                    key: "feather".into(),
                    default_value: 32.0,
                },
            ]),
            "drizzle" => Some(vec![
                PixelParameter {
                    key: "radius".into(),
                    default_value: 42.0,
                },
                PixelParameter {
                    key: "width".into(),
                    default_value: 3.0,
                },
            ]),
            "hair" => Some(vec![
                PixelParameter {
                    key: "length".into(),
                    default_value: 48.0,
                },
                PixelParameter {
                    key: "thickness".into(),
                    default_value: 1.5,
                },
                PixelParameter {
                    key: "wave".into(),
                    default_value: 18.0,
                },
            ]),
            "particle-systems-ii" => Some(vec![PixelParameter {
                key: "size".into(),
                default_value: 5.0,
            }]),
            "pixel-polly" => Some(vec![
                PixelParameter {
                    key: "tileSize".into(),
                    default_value: 42.0,
                },
                PixelParameter {
                    key: "scatter".into(),
                    default_value: 360.0,
                },
                PixelParameter {
                    key: "gravity".into(),
                    default_value: 280.0,
                },
            ]),
            "texturize" => Some(vec![PixelParameter {
                key: "scale".into(),
                default_value: 64.0,
            }]),
            "tiles" => Some(vec![]),
            "light-wrap" => Some(vec![PixelParameter {
                key: "size".into(),
                default_value: 18.0,
            }]),
            "light-rays" => Some(vec![PixelParameter {
                key: "length".into(),
                default_value: 240.0,
            }]),
            "light-leak" => Some(vec![]),
            "laser" => Some(vec![
                PixelParameter {
                    key: "core".into(),
                    default_value: 2.0,
                },
                PixelParameter {
                    key: "glow".into(),
                    default_value: 18.0,
                },
            ]),
            "log-wheels" => Some(vec![]),
            "hsl-secondary" => Some(vec![]),
            "highlight-recovery" => Some(vec![]),
            "tape-dropout" => Some(vec![
                PixelParameter {
                    key: "length".into(),
                    default_value: 420.0,
                },
                PixelParameter {
                    key: "height".into(),
                    default_value: 3.0,
                },
            ]),
            "head-switching" => Some(vec![PixelParameter {
                key: "amount".into(),
                default_value: 72.0,
            }]),
            "pixel-sort" => Some(vec![PixelParameter {
                key: "length".into(),
                default_value: 72.0,
            }]),
            "power-pin" => Some(vec![]),
            "paint-bucket" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 720.0,
            }]),
            "detail-preserving-upscale" => Some(vec![]),
            "deband" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 6.0,
            }]),
            "denoise" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 2.0,
            }]),
            "local-contrast" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 36.0,
            }]),
            _ => None,
        }
    }
}
