//! Time-addressable animation primitives.

mod animation;
mod time;

pub use animation::{Animatable, CubicBezier, Interpolation, Keyframe};
pub use time::{FrameRate, Time, TimeError};
