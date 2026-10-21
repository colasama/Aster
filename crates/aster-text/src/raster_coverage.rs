use crate::{GlyphCoverage, GlyphImage, GlyphImageFormat};

impl GlyphCoverage {
    pub(crate) fn apply(self, image: &mut GlyphImage) {
        if self == Self::Linear || image.format != GlyphImageFormat::Coverage {
            return;
        }
        let table = self.table(image.key.foreground);
        for value in &mut image.data {
            *value = table[usize::from(*value)];
        }
    }

    fn table(self, foreground: [u8; 4]) -> [u8; 256] {
        let decode = |v: f64| {
            if v <= 0.04045 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        };
        let encode = |v: f64| {
            if v <= 0.0031308 {
                v * 12.92
            } else {
                1.055 * v.powf(1. / 2.4) - 0.055
            }
        };
        // Windows Canvas uses sRGB mask gamma, full contrast and a three-bit luminance bucket.
        // Coverage belongs in the cache identity because its transfer depends on the paint color.
        let color = foreground.map(|v| f64::from(v) / 255.);
        let luma = encode(
            0.2126 * decode(color[0]) + 0.7152 * decode(color[1]) + 0.0722 * decode(color[2]),
        );
        let bucket = ((luma * 255.).round() as u8) >> 5;
        let src = f64::from((bucket << 5) | (bucket << 2) | (bucket >> 1)) / 255.;
        let dst = 1. - src;
        let linear_src = decode(src);
        let linear_dst = decode(dst);
        std::array::from_fn(|index| {
            if self == Self::Linear {
                return index as u8;
            }
            let alpha = index as f64 / 255.;
            let alpha = alpha + (1. - alpha) * linear_dst * alpha;
            let out = encode(linear_src * alpha + linear_dst * (1. - alpha));
            (((out - dst) / (src - dst)).clamp(0., 1.) * 255.).round() as u8
        })
    }
}

#[test]
fn coverage_transfer_preserves_endpoints_and_monotonicity_for_every_bucket() {
    for value in 0..=255 {
        let table = GlyphCoverage::CanvasSrgb.table([value; 4]);
        assert_eq!(table[0], 0);
        assert_eq!(table[255], 255);
        assert!(table.windows(2).all(|pair| pair[0] <= pair[1]));
    }
}
