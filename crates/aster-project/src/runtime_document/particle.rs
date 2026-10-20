use super::{Json, Object, RuntimeProjectDocument};
use crate::ProjectError;
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Generator {
    plugin_id: &'static str,
    node_type: &'static str,
    api_version: u32,
    parameters: Json,
}
impl RuntimeProjectDocument {
    pub(super) fn particles(document: &mut Object) -> Result<(), ProjectError> {
        for composition in Self::compositions(document) {
            for layer in Self::layers(composition) {
                if layer.get("kind").and_then(Json::string) != Some("particle") {
                    continue;
                }
                let Some(particle) = layer.get("particle").filter(|v| v.truthy()) else {
                    continue;
                };
                Self::validate_particle(particle)?;
                let generator = Generator {
                    plugin_id: "org.aster.builtin.particles",
                    node_type: "particle_system",
                    api_version: 1,
                    parameters: particle.clone(),
                };
                layer.set("kind", Json::String("generator".into()));
                layer.set("generator", Json::typed(&generator)?);
                layer.remove("particle");
            }
        }
        Ok(())
    }
    fn validate_particle(value: &Json) -> Result<(), ProjectError> {
        let invalid = || ProjectError::InvalidEditorDocument("invalid legacy particle settings");
        let particle = value.object().ok_or_else(invalid)?;
        let mut expected = BTreeSet::new();
        for (key, options) in [
            ("renderMode", &["billboard", "streak", "mesh"][..]),
            ("meshPrimitive", &["cube"][..]),
            (
                "emitterShape",
                &["point", "box", "sphere", "ring", "line"][..],
            ),
        ] {
            expected.insert(key);
            if !particle
                .get(key)
                .and_then(Json::string)
                .is_some_and(|v| options.contains(&v))
            {
                return Err(invalid());
            }
        }
        for (key, min, max, integer) in [
            ("count", 1.0, 1_000_000.0, true),
            ("seed", 0.0, 16_777_215.0, true),
            ("lifetime", 0.05, 3_600.0, false),
            ("emitterSpread", 0.0, 180.0, false),
            ("drag", 0.0, 10.0, false),
            ("turbulence", 0.0, 10.0, false),
            ("turbulenceScale", 0.01, 100.0, false),
            ("startOpacity", 0.0, 1.0, false),
            ("endOpacity", 0.0, 1.0, false),
            ("startSize", 0.01, 256.0, false),
            ("endSize", 0.01, 256.0, false),
            ("startRotation", -36_000.0, 36_000.0, false),
            ("endRotation", -36_000.0, 36_000.0, false),
            ("streakLength", 0.01, 5.0, false),
        ] {
            expected.insert(key);
            if !particle
                .get(key)
                .and_then(Json::finite)
                .is_some_and(|v| v >= min && v <= max && (!integer || v.fract() == 0.0))
            {
                return Err(invalid());
            }
        }
        for (key, min, max) in [
            ("emitterPosition", -4.0, 4.0),
            ("emitterSize", 0.0, 8.0),
            ("velocity", -10.0, 10.0),
            ("gravity", -10.0, 10.0),
            ("startColor", 0.0, 16.0),
            ("endColor", 0.0, 16.0),
        ] {
            expected.insert(key);
            if !particle.get(key).and_then(Json::array).is_some_and(|v| {
                v.len() == 3
                    && v.iter()
                        .all(|v| v.finite().is_some_and(|v| v >= min && v <= max))
            }) {
                return Err(invalid());
            }
        }
        if particle.keys().any(|key| !expected.contains(key)) {
            return Err(invalid());
        }
        Ok(())
    }
}
