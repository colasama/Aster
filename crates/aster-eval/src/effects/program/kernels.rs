// Generated kernel dispatch.
use crate::EffectFrame;
pub(super) struct EffectKernels;
impl EffectKernels {
    pub fn operation(effect_type: &str, frame: &EffectFrame) -> Option<[f64; 16]> {
        Self::base_0(effect_type, frame)
            .or_else(|| Self::base_1(effect_type, frame))
            .or_else(|| Self::base_2(effect_type, frame))
            .or_else(|| Self::base_3(effect_type, frame))
            .or_else(|| Self::base_4(effect_type, frame))
            .or_else(|| Self::advanced_distort(effect_type, frame))
            .or_else(|| Self::blur_sharpen(effect_type, frame))
            .or_else(|| Self::channel_keying(effect_type, frame))
            .or_else(|| Self::channel_utility(effect_type, frame))
            .or_else(|| Self::color_pipeline(effect_type, frame))
            .or_else(|| Self::detail_processing(effect_type, frame))
            .or_else(|| Self::draw_generators(effect_type, frame))
            .or_else(|| Self::framing(effect_type, frame))
            .or_else(|| Self::immersive_video(effect_type, frame))
            .or_else(|| Self::keying_cleanup(effect_type, frame))
            .or_else(|| Self::layer_styles(effect_type, frame))
            .or_else(|| Self::lighting(effect_type, frame))
            .or_else(|| Self::matte(effect_type, frame))
            .or_else(|| Self::noise_grain(effect_type, frame))
            .or_else(|| Self::perspective(effect_type, frame))
            .or_else(|| Self::professional_color(effect_type, frame))
            .or_else(|| Self::qc_overlays(effect_type, frame))
            .or_else(|| Self::retro_media(effect_type, frame))
            .or_else(|| Self::simulation(effect_type, frame))
            .or_else(|| Self::stylize(effect_type, frame))
            .or_else(|| Self::transitions(effect_type, frame))
            .or_else(|| Self::bokeh(effect_type, frame))
            .or_else(|| Self::gradient(effect_type, frame))
    }
}
