//! Time-addressable animation primitives.

mod animation;
mod property;
mod time;

pub use animation::{Animatable, CubicBezier, Interpolation, Keyframe};
pub use property::{
    Quaternion, QuaternionAnimatable, QuaternionKeyframe, StringAnimatable, StringKeyframe,
};
pub use time::{FrameRate, Time, TimeError};
