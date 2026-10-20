use super::{super::EffectColorTrack, EffectKernels};
use crate::EffectFrame;
use std::cmp::Ordering;

impl EffectKernels {
    pub(super) fn gradient(effect_type: &str, frame: &EffectFrame) -> Option<[f64; 16]> {
        if effect_type != "multi-stop-gradient" {
            return None;
        }
        let mut stops = [
            [0.0, frame.gradient_color("color1", f64::from(0x38cddd))],
            [
                frame.value("position2", 25.0) / 100.0,
                frame.gradient_color("color2", f64::from(0xd9f3f2)),
            ],
            [
                frame.value("position3", 50.0) / 100.0,
                frame.gradient_color("color3", f64::from(0xe757a4)),
            ],
            [
                frame.value("position4", 80.0) / 100.0,
                frame.gradient_color("color4", f64::from(0x0784d5)),
            ],
            [1.0, frame.gradient_color("color5", f64::from(0x021a2b))],
        ];
        for stop in &mut stops {
            stop[0] = stop[0].clamp(0.0, 1.0);
            stop[1] = f64::from(EffectColorTrack::packed(stop[1]));
        }
        // Equal-position stops retain authored order, including signed zero.
        stops.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap_or(Ordering::Equal));
        Some([
            267.0,
            frame.value("startX", 0.0) / 100.0,
            frame.value("startY", 50.0) / 100.0,
            frame.value("endX", 100.0) / 100.0,
            frame.value("endY", 50.0) / 100.0,
            stops[0][1],
            stops[1][1],
            stops[2][1],
            stops[3][1],
            stops[4][1],
            stops[1][0],
            stops[2][0],
            stops[3][0],
            frame.value("interpolation", 0.0),
            frame.value("blend", 100.0) / 100.0,
            frame.value("mapping", 0.0),
        ])
    }
}
