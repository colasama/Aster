use crate::expression::NumericFunction;

pub(super) struct TextMath;
impl TextMath {
    pub fn bounded(value: f64, minimum: f64, maximum: f64, fallback: f64) -> f64 {
        if value.is_finite() {
            value.clamp(minimum, maximum)
        } else {
            fallback.clamp(minimum, maximum)
        }
    }
    pub fn round(value: f64) -> f64 {
        NumericFunction::round(value)
    }
    pub fn smooth(value: f64) -> f64 {
        let value = value.clamp(0.0, 1.0);
        value * value * (3.0 - 2.0 * value)
    }
    pub fn int32(value: f64) -> u32 {
        if !value.is_finite() || value == 0.0 {
            0
        } else {
            value.trunc().rem_euclid(4_294_967_296.0) as u32
        }
    }
    pub fn hash(value: &str) -> u32 {
        value.encode_utf16().fold(0x811c9dc5u32, |hash, unit| {
            (hash ^ u32::from(unit)).wrapping_mul(0x01000193)
        })
    }
    pub fn random(value: u32) -> u32 {
        let mut state = value.wrapping_add(0x6d2b79f5);
        state = (state ^ (state >> 15)).wrapping_mul(state | 1);
        state ^= state.wrapping_add((state ^ (state >> 7)).wrapping_mul(state | 61));
        state ^ (state >> 14)
    }
    pub fn randomized_index(index: u32, count: u32, seed: f64) -> f64 {
        if count <= 1 {
            return 0.0;
        }
        let truncated = seed.trunc();
        let seed = Self::int32(if truncated == 0.0 {
            f64::from(0x6d2b79f5u32)
        } else {
            truncated
        });
        let mut state = Self::random(seed);
        let mut multiplier = (state % count) | 1;
        while Self::gcd(multiplier, count) != 1 {
            multiplier = ((u64::from(multiplier) + 2) % u64::from(count)) as u32;
            if multiplier == 0 {
                multiplier = 1;
            }
        }
        state = Self::random(state);
        (f64::from(multiplier.wrapping_mul(index) as i32) + f64::from(state % count))
            % f64::from(count)
    }
    fn gcd(mut a: u32, mut b: u32) -> u32 {
        while b > 0 {
            (a, b) = (b, a % b);
        }
        a
    }
    fn noise(seed: f64, time: f64, spatial: f64) -> f64 {
        let mut state = Self::int32(seed) ^ Self::int32(time).wrapping_mul(0x9e3779b1);
        state ^= Self::int32(spatial * 65_536.0).wrapping_mul(0x85ebca6b);
        f64::from(Self::random(state)) / f64::from(u32::MAX)
    }
    pub fn interpolate_noise(seed: f64, time: f64, mix: f64, spatial: f64) -> f64 {
        let first = Self::noise(seed, time, spatial);
        let second = Self::noise(seed, time + 1.0, spatial);
        first + (second - first) * mix
    }
}
