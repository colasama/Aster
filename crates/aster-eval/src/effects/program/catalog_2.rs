// Generated effect pixel-unit metadata.
use super::catalog::EffectCatalog;
use crate::PixelParameter;
impl EffectCatalog {
    pub(super) fn catalog_2(effect_type: &str) -> Option<Vec<PixelParameter>> {
        match effect_type {
            "radial-blur" => Some(vec![]),
            "bilateral-blur" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 12.0,
            }]),
            "brightness-contrast" => Some(vec![]),
            "vibrance" => Some(vec![]),
            "bulge" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 300.0,
            }]),
            "fractal-noise" => Some(vec![PixelParameter {
                key: "scale".into(),
                default_value: 180.0,
            }]),
            "four-color-gradient" => Some(vec![]),
            "bloom" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 96.0,
            }]),
            "find-edges" => Some(vec![]),
            "radial-wipe" => Some(vec![]),
            "film-emulation" => Some(vec![PixelParameter {
                key: "weave".into(),
                default_value: 0.0,
            }]),
            "fill" => Some(vec![]),
            "noise" => Some(vec![]),
            "venetian-blinds" => Some(vec![
                PixelParameter {
                    key: "width".into(),
                    default_value: 80.0,
                },
                PixelParameter {
                    key: "feather".into(),
                    default_value: 4.0,
                },
            ]),
            "black-white" => Some(vec![]),
            "bevel-alpha" => Some(vec![PixelParameter {
                key: "relief".into(),
                default_value: 4.0,
            }]),
            "box-blur" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 12.0,
            }]),
            "roughen-edges" => Some(vec![
                PixelParameter {
                    key: "border".into(),
                    default_value: 12.0,
                },
                PixelParameter {
                    key: "scale".into(),
                    default_value: 80.0,
                },
            ]),
            "radial-shadow" => Some(vec![
                PixelParameter {
                    key: "distance".into(),
                    default_value: 48.0,
                },
                PixelParameter {
                    key: "softness".into(),
                    default_value: 18.0,
                },
            ]),
            "ball-action" => Some(vec![
                PixelParameter {
                    key: "gridSize".into(),
                    default_value: 36.0,
                },
                PixelParameter {
                    key: "scatter".into(),
                    default_value: 0.0,
                },
            ]),
            "beam" => Some(vec![
                PixelParameter {
                    key: "thickness".into(),
                    default_value: 12.0,
                },
                PixelParameter {
                    key: "softness".into(),
                    default_value: 8.0,
                },
            ]),
            "radio-waves" => Some(vec![PixelParameter {
                key: "width".into(),
                default_value: 4.0,
            }]),
            "vr-rotate-sphere" => Some(vec![]),
            "vr-plane-to-sphere" => Some(vec![]),
            "vr-chromatic-aberrations" => Some(vec![]),
            "vr-digital-glitch" => Some(vec![
                PixelParameter {
                    key: "amount".into(),
                    default_value: 32.0,
                },
                PixelParameter {
                    key: "bandSize".into(),
                    default_value: 48.0,
                },
                PixelParameter {
                    key: "colorSplit".into(),
                    default_value: 6.0,
                },
            ]),
            "vr-color-gradients" => Some(vec![]),
            "vr-glow" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 18.0,
            }]),
            "vr-blur" => Some(vec![
                PixelParameter {
                    key: "horizontal".into(),
                    default_value: 12.0,
                },
                PixelParameter {
                    key: "vertical".into(),
                    default_value: 8.0,
                },
            ]),
            "vr-fractal-noise" => Some(vec![]),
            "ripple" => Some(vec![
                PixelParameter {
                    key: "height".into(),
                    default_value: 18.0,
                },
                PixelParameter {
                    key: "width".into(),
                    default_value: 120.0,
                },
                PixelParameter {
                    key: "radius".into(),
                    default_value: 600.0,
                },
            ]),
            "rainfall" => Some(vec![
                PixelParameter {
                    key: "length".into(),
                    default_value: 48.0,
                },
                PixelParameter {
                    key: "width".into(),
                    default_value: 1.5,
                },
            ]),
            "block-dissolve" => Some(vec![
                PixelParameter {
                    key: "blockWidth".into(),
                    default_value: 64.0,
                },
                PixelParameter {
                    key: "blockHeight".into(),
                    default_value: 36.0,
                },
            ]),
            "barn-doors" => Some(vec![PixelParameter {
                key: "feather".into(),
                default_value: 8.0,
            }]),
            "burn-film" => Some(vec![
                PixelParameter {
                    key: "turbulence".into(),
                    default_value: 90.0,
                },
                PixelParameter {
                    key: "edgeWidth".into(),
                    default_value: 26.0,
                },
            ]),
            "brush-strokes" => Some(vec![
                PixelParameter {
                    key: "length".into(),
                    default_value: 26.0,
                },
                PixelParameter {
                    key: "grain".into(),
                    default_value: 48.0,
                },
            ]),
            "broadcast-colors" => Some(vec![]),
            "filmic-tone-map" => Some(vec![]),
            "remove-color-matting" => Some(vec![]),
            "vector-blur" => Some(vec![PixelParameter {
                key: "amount".into(),
                default_value: 24.0,
            }]),
            "radial-fast-blur" => Some(vec![]),
            "fast-bokeh" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 40.0,
            }]),
            "bend-it" => Some(vec![PixelParameter {
                key: "bend".into(),
                default_value: 120.0,
            }]),
            "bevel-emboss-style" => Some(vec![PixelParameter {
                key: "size".into(),
                default_value: 8.0,
            }]),
            "noise-alpha" => Some(vec![PixelParameter {
                key: "size".into(),
                default_value: 1.0,
            }]),
            "noise-hls" => Some(vec![PixelParameter {
                key: "size".into(),
                default_value: 1.0,
            }]),
            "noise-hls-auto" => Some(vec![PixelParameter {
                key: "size".into(),
                default_value: 1.0,
            }]),
            "remove-grain" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 2.5,
            }]),
            "jaws" => Some(vec![PixelParameter {
                key: "feather".into(),
                default_value: 3.0,
            }]),
            "bubbles" => Some(vec![
                PixelParameter {
                    key: "size".into(),
                    default_value: 14.0,
                },
                PixelParameter {
                    key: "wobble".into(),
                    default_value: 18.0,
                },
            ]),
            "refine-hard-matte" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 2.0,
            }]),
            "refine-soft-matte" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 4.0,
            }]),
            "volumetric-fog" => Some(vec![PixelParameter {
                key: "scale".into(),
                default_value: 280.0,
            }]),
            "rgb-lift-gamma-gain" => Some(vec![]),
            "false-color" => Some(vec![]),
            "film-print-density" => Some(vec![]),
            "zebra-overlay" => Some(vec![PixelParameter {
                key: "spacing".into(),
                default_value: 16.0,
            }]),
            "focus-peaking" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 1.5,
            }]),
            "film-damage" => Some(vec![]),
            "rgb-phosphor" => Some(vec![
                PixelParameter {
                    key: "pitch".into(),
                    default_value: 3.0,
                },
                PixelParameter {
                    key: "colorBleed".into(),
                    default_value: 1.5,
                },
            ]),
            "bezier-warp" => Some(vec![
                PixelParameter {
                    key: "topBend".into(),
                    default_value: 0.0,
                },
                PixelParameter {
                    key: "bottomBend".into(),
                    default_value: 0.0,
                },
                PixelParameter {
                    key: "leftBend".into(),
                    default_value: 0.0,
                },
                PixelParameter {
                    key: "rightBend".into(),
                    default_value: 0.0,
                },
            ]),
            "flo-motion" => Some(vec![
                PixelParameter {
                    key: "amount1".into(),
                    default_value: 80.0,
                },
                PixelParameter {
                    key: "amount2".into(),
                    default_value: -80.0,
                },
                PixelParameter {
                    key: "radius".into(),
                    default_value: 260.0,
                },
            ]),
            "ripple-pulse" => Some(vec![
                PixelParameter {
                    key: "radius".into(),
                    default_value: 280.0,
                },
                PixelParameter {
                    key: "waveWidth".into(),
                    default_value: 80.0,
                },
                PixelParameter {
                    key: "amplitude".into(),
                    default_value: 28.0,
                },
            ]),
            "vegas" => Some(vec![
                PixelParameter {
                    key: "edgeRadius".into(),
                    default_value: 2.0,
                },
                PixelParameter {
                    key: "segmentLength".into(),
                    default_value: 48.0,
                },
                PixelParameter {
                    key: "width".into(),
                    default_value: 6.0,
                },
            ]),
            "reduce-interlace-flicker" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 1.0,
            }]),
            "frequency-separation" => Some(vec![PixelParameter {
                key: "radius".into(),
                default_value: 8.0,
            }]),
            _ => None,
        }
    }
}
