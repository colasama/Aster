use std::error::Error;

use aster_eval::{EvaluationLimits, ScalarTrack};
use aster_types::editor::Animatable;

#[test]
fn arbitrary_seeks_and_last_key_speed_are_time_addressable() -> Result<(), Box<dyn Error>> {
    let property: Animatable = serde_json::from_str(
        r#"{"mode":"animated","keyframes":[
        {"id":"a","time":1,"value":10,"interpolation":"linear"},
        {"id":"b","time":3,"value":30,"interpolation":"step"},
        {"id":"c","time":5,"value":-20,"interpolation":"linear"},
        {"id":"d","time":6,"value":0,"interpolation":"linear"}] }"#,
    )?;
    let track = ScalarTrack::compile(&property, &EvaluationLimits::default())?;
    for (time, value, speed) in [
        (7., 0., 0.),
        (2., 20., 10.),
        (4., 30., 0.),
        (6., 0., 20.),
        (0., 10., 0.),
        (5., -20., 20.),
        (1., 10., 10.),
    ] {
        assert_eq!(track.evaluate(time)?, value);
        assert_eq!(track.speed(time)?, speed);
    }
    for time in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(track.evaluate(time).is_err());
        assert!(track.speed(time).is_err());
    }
    assert!(ScalarTrack::compile(&property, &EvaluationLimits { max_keyframes: 3 }).is_err());
    Ok(())
}

#[test]
fn empty_tracks_and_sub_epsilon_segments_match_existing_behavior() -> Result<(), Box<dyn Error>> {
    let empty = serde_json::from_str(r#"{"mode":"animated","keyframes":[]}"#)?;
    let track = ScalarTrack::compile(&empty, &EvaluationLimits::default())?;
    assert_eq!(track.evaluate(100.)?, 0.);
    assert_eq!(track.speed(100.)?, 0.);
    let tiny = serde_json::from_str(
        r#"{"mode":"animated","keyframes":[
        {"id":"a","time":0,"value":1,"interpolation":"linear"},
        {"id":"b","time":1e-17,"value":4,"interpolation":"linear"}]}"#,
    )?;
    let track = ScalarTrack::compile(&tiny, &EvaluationLimits::default())?;
    assert_eq!(track.evaluate(5e-18)?, 4.);
    assert_eq!(track.speed(5e-18)?, 0.);
    Ok(())
}
