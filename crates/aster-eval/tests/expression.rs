use std::error::Error;

use aster_eval::{ExpressionBinding, ExpressionContext, ExpressionLimits, ExpressionProgram};

#[test]
fn compiled_expression_keeps_seek_and_error_fallback_local() -> Result<(), Box<dyn Error>> {
    let limits = ExpressionLimits::default();
    let program = ExpressionProgram::compile("value + 10 * pow(1 - beatphase(120), 3)", &limits)?;
    for (time, expected) in [(0.25, 6.25), (0., 15.), (10., 15.), (-0.25, 6.25)] {
        assert_eq!(
            program.evaluate(ExpressionContext { time, value: 5. })?,
            expected
        );
    }
    let binding = ExpressionBinding::compile("value / time", &limits);
    assert_eq!(
        binding.evaluate(ExpressionContext {
            time: 0.,
            value: 8.
        }),
        8.
    );
    assert_eq!(
        binding.evaluate(ExpressionContext {
            time: 2.,
            value: 8.
        }),
        4.
    );
    let invalid = ExpressionBinding::compile("globalThis.alert(1)", &limits);
    assert!(invalid.compile_error.is_some());
    assert_eq!(
        invalid.evaluate(ExpressionContext {
            time: 0.,
            value: 17.
        }),
        17.
    );
    Ok(())
}

#[test]
fn admission_limits_include_end_token_and_match_parser_depth() {
    let limits = ExpressionLimits::default();
    assert!(ExpressionProgram::compile(&format!("{}1", "1+".repeat(255)), &limits).is_ok());
    assert!(ExpressionProgram::compile(&format!("{}1", "1+".repeat(256)), &limits).is_err());
    assert!(
        ExpressionProgram::compile(&format!("{}1{}", "(".repeat(31), ")".repeat(31)), &limits)
            .is_ok()
    );
    assert!(
        ExpressionProgram::compile(&format!("{}1{}", "(".repeat(32), ")".repeat(32)), &limits)
            .is_err()
    );
    assert!(ExpressionProgram::compile(&format!("{}1", " ".repeat(2047)), &limits).is_ok());
    assert!(ExpressionProgram::compile(&format!("{}1", " ".repeat(2048)), &limits).is_err());
    assert!(
        ExpressionProgram::compile(
            "1",
            &ExpressionLimits {
                max_expression_units: 0,
                ..limits.clone()
            }
        )
        .is_err()
    );
    assert!(
        ExpressionProgram::compile(
            "1",
            &ExpressionLimits {
                max_expression_tokens: 1,
                ..limits.clone()
            }
        )
        .is_err()
    );
    assert!(
        ExpressionProgram::compile(
            "1",
            &ExpressionLimits {
                max_expression_depth: 0,
                ..limits
            }
        )
        .is_err()
    );
}
