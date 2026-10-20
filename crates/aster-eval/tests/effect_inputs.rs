use aster_eval::{EffectLimits, EffectTrack, EvaluationLimits, ExpressionLimits, PixelParameter};
use aster_types::editor::Effect;
use std::error::Error;

struct EffectFixture;
impl EffectFixture {
    fn compile(source: &str) -> Result<EffectTrack, Box<dyn Error>> {
        let effect: Effect = serde_json::from_str(source)?;
        Ok(EffectTrack::compile(
            &effect,
            &EffectLimits::default(),
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?)
    }
}

#[test]
fn scaled_pixel_expression_uses_scaled_value_again() -> Result<(), Box<dyn Error>> {
    let track = EffectFixture::compile(
        r#"{"id":"e","name":"Blur","type":"gaussian-blur","enabled":true,"parameters":{"radius":12},"parameterKeyframes":{"radius":[]},"parameterExpressions":{"radius":"value * 2 + time"}}"#,
    )?;
    let mut frame = track.evaluate(1.0)?;
    assert_eq!(frame.value("radius", 0.0), 25.0);
    frame.scale_pixels(
        &[PixelParameter {
            key: "radius".into(),
            default_value: 18.0,
        }],
        2.0,
    )?;
    assert_eq!(frame.value("radius", 0.0), 101.0);
    assert_eq!(track.evaluate(1.0)?.value("radius", 0.0), 25.0);
    assert_eq!(frame.value("missing", -12.0), -12.0);
    assert!(frame.scale_pixels(&[], f64::NAN).is_err());
    Ok(())
}

#[test]
fn gradient_channels_interpolate_without_packed_integer_flash() -> Result<(), Box<dyn Error>> {
    let track = EffectFixture::compile(
        r#"{"id":"e","name":"Gradient","type":"multi-stop-gradient","enabled":true,"parameters":{"color1":0},"parameterExpressions":{"color1":"0"},"parameterKeyframes":{"color1":[{"id":"a","time":0,"value":16711680,"interpolation":"linear"},{"id":"b","time":1,"value":255,"interpolation":"linear"}]}}"#,
    )?;
    let frame = track.evaluate(0.5)?;
    assert_eq!(frame.value("color1", 0.0), 0.0);
    assert_eq!(frame.gradient_color("color1", 0.0), f64::from(0x800080));
    assert_eq!(frame.gradient_color("color2", 0.0), 0.0);
    Ok(())
}

#[test]
fn effect_parameters_are_bounded_before_compilation() -> Result<(), Box<dyn Error>> {
    let effect: Effect = serde_json::from_str(
        r#"{"id":"e","name":"Blur","type":"gaussian-blur","enabled":true,"parameters":{"radius":1}}"#,
    )?;
    let limits = EffectLimits {
        max_effect_parameters: 0,
        ..EffectLimits::default()
    };
    assert!(
        EffectTrack::compile(
            &effect,
            &limits,
            &EvaluationLimits::default(),
            &ExpressionLimits::default()
        )
        .is_err()
    );
    Ok(())
}
