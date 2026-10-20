// Generated effect pixel-unit metadata.
use super::catalog::EffectCatalog;
use crate::PixelParameter;
impl EffectCatalog {
    pub(super) fn catalog_1(effect_type: &str) -> Option<Vec<PixelParameter>> {
        match effect_type {
            "exposure" => Some(vec![]),
            "minimax" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 2.0,
            }]),
            "mosaic" => Some(vec![]),
            "emboss" => Some(vec![]),
            "echo" => Some(vec![]),
            "motion-trails" => Some(vec![]),
            "invert" => Some(vec![]),
            "mirror" => Some(vec![]),
            "motion-tile" => Some(vec![]),
            "extract" => Some(vec![]),
            "multi-stop-gradient" => Some(vec![]),
            "advanced-lightning" => Some(vec![
                PixelParameter {
                    key: "amplitude".into(),
                    default_value: 48.0,
                },
                PixelParameter {
                    key: "thickness".into(),
                    default_value: 2.5,
                },
                PixelParameter {
                    key: "glow".into(),
                    default_value: 22.0,
                },
            ]),
            "magnify" => Some(vec![
                PixelParameter {
                    key: "size".into(),
                    default_value: 280.0,
                },
                PixelParameter {
                    key: "feather".into(),
                    default_value: 48.0,
                },
            ]),
            "edge-feather" => Some(vec![PixelParameter {
                key: "width".into(),
                default_value: 72.0,
            }]),
            "iris-wipe" => Some(vec![PixelParameter {
                key: "feather".into(),
                default_value: 12.0,
            }]),
            "arithmetic" => Some(vec![]),
            "alpha-levels" => Some(vec![]),
            "matte-choker" => Some(vec![
                PixelParameter {
                    key: "choke".into(),
                    default_value: 4.0,
                },
                PixelParameter {
                    key: "softness".into(),
                    default_value: 2.0,
                },
            ]),
            "edge-extend" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 3.0,
            }]),
            "edge-color-blend" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 4.0,
            }]),
            "unpremultiply-color" => Some(vec![]),
            "alpha-from-luminance" => Some(vec![]),
            "mesh-warp" => Some(vec![
                PixelParameter {
                    key: "horizontal".into(),
                    default_value: 32.0,
                },
                PixelParameter {
                    key: "vertical".into(),
                    default_value: 32.0,
                },
            ]),
            "inner-glow" => Some(vec![PixelParameter {
                key: "size".into(),
                default_value: 18.0,
            }]),
            "alpha-stroke" => Some(vec![PixelParameter {
                key: "size".into(),
                default_value: 6.0,
            }]),
            "inner-shadow" => Some(vec![
                PixelParameter {
                    key: "distance".into(),
                    default_value: 12.0,
                },
                PixelParameter {
                    key: "size".into(),
                    default_value: 12.0,
                },
            ]),
            "add-grain" => Some(vec![PixelParameter {
                key: "size".into(),
                default_value: 1.4,
            }]),
            "median" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 2.0,
            }]),
            "mr-mercury" => Some(vec![PixelParameter {
                key: "blobSize".into(),
                default_value: 54.0,
            }]),
            "matte-feather" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 12.0,
            }]),
            "matte-cleanup" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 2.0,
            }]),
            "edge-decontaminate" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 3.0,
            }]),
            "alpha-bevel" => Some(vec![PixelParameter {
                key: "size".into(),
                default_value: 5.0,
            }]),
            "alpha-erode-dilate" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 3.0,
            }]),
            "anamorphic-flare" => Some(vec![
                PixelParameter {
                    key: "length".into(),
                    default_value: 640.0,
                },
                PixelParameter {
                    key: "width".into(),
                    default_value: 6.0,
                },
            ]),
            "asc-cdl" => Some(vec![]),
            "alpha-boundary" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 2.0,
            }]),
            "ellipse" => Some(vec![
                PixelParameter {
                    key: "width".into(),
                    default_value: 480.0,
                },
                PixelParameter {
                    key: "height".into(),
                    default_value: 280.0,
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
            "eyedropper-fill" => Some(vec![]),
            _ => None,
        }
    }
}
