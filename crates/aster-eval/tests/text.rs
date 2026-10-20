use aster_eval::{
    EvaluationLimits, ExpressionLimits, TextAnimatorTrack, TextBaseStyle, TextExpressionBinding,
    TextExpressionContext, TextLimits, TextUnitContext,
};
use aster_types::editor::TextAnimator;
use std::error::Error;

struct TextFixture;
impl TextFixture {
    fn settings() -> Result<TextAnimator, serde_json::Error> {
        serde_json::from_str(
            r#"{"enabled":true,"groups":[{"id":"g","name":"Group","enabled":true,"randomSeed":0,"selectors":[],"properties":{"position":[{"mode":"static","value":10},{"mode":"static","value":20},{"mode":"static","value":30}]}}]}"#,
        )
    }
    fn unit() -> TextUnitContext {
        TextUnitContext {
            character_index: 0,
            character_count: 1,
            character_excluding_spaces_index: Some(0),
            character_excluding_spaces_count: 1,
            word_index: 0,
            word_count: 1,
            line_index: 0,
            line_count: 1,
            is_whitespace: false,
        }
    }
}

#[test]
fn text_admission_respects_budgets_and_identity() -> Result<(), Box<dyn Error>> {
    let mut settings = TextFixture::settings()?;
    let eval = EvaluationLimits::default();
    let expr = ExpressionLimits::default();
    let limits = TextLimits {
        max_text_groups: 0,
        ..TextLimits::default()
    };
    assert!(TextAnimatorTrack::compile(&settings, &limits, &eval, &expr).is_err());
    settings.groups.push(settings.groups[0].clone());
    assert!(TextAnimatorTrack::compile(&settings, &TextLimits::default(), &eval, &expr).is_err());
    settings.groups[1].id = "independent".into();
    assert!(TextAnimatorTrack::compile(&settings, &TextLimits::default(), &eval, &expr).is_ok());
    Ok(())
}

#[test]
fn supplied_layout_domains_cannot_escape_bounds() -> Result<(), Box<dyn Error>> {
    let track = TextAnimatorTrack::compile(
        &TextFixture::settings()?,
        &TextLimits::default(),
        &EvaluationLimits::default(),
        &ExpressionLimits::default(),
    )?;
    let frame = track.evaluate(2.0)?;
    let base = TextBaseStyle::default();
    let mut unit = TextFixture::unit();
    assert_eq!(
        frame.character(&unit, &base, true)?.position,
        [10.0, 20.0, 30.0]
    );
    unit.character_count = 4097;
    assert!(frame.character(&unit, &base, true).is_err());
    unit = TextFixture::unit();
    unit.character_excluding_spaces_index = Some(1);
    assert!(frame.character(&unit, &base, true).is_err());
    unit = TextFixture::unit();
    unit.line_index = 1;
    assert!(frame.character(&unit, &base, true).is_err());
    Ok(())
}

#[test]
fn selector_runtime_failure_does_not_poison_later_characters() -> Result<(), Box<dyn Error>> {
    let limits = ExpressionLimits::default();
    let program = TextExpressionBinding::compile("100/(textIndex-2)", &limits);
    let mut context = TextExpressionContext {
        time: 0.0,
        text_index: 2.0,
        text_total: 5.0,
        selector_value: 75.0,
    };
    assert_eq!(program.evaluate_or_fallback(context), 75.0);
    context.text_index = 3.0;
    assert_eq!(program.evaluate(context)?, 100.0);
    for source in ["TEXTINDEX", "selectorvalue", "SIN(0)"] {
        assert!(
            TextExpressionBinding::compile(source, &limits)
                .evaluate(context)
                .is_err()
        );
    }
    assert_eq!(
        TextExpressionBinding::compile("sqrt(-1)", &limits).evaluate(context)?,
        0.0
    );
    assert!(
        TextExpressionBinding::compile("pow(1,1/0)", &limits)
            .evaluate(context)
            .is_err()
    );
    Ok(())
}
