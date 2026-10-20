use super::{Json, Object, RuntimeProjectDocument, StaticProperty};
use crate::ProjectError;
use serde::Serialize;

#[derive(Serialize)]
struct Stack {
    enabled: bool,
    groups: [Group; 1],
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Group {
    id: String,
    name: &'static str,
    enabled: bool,
    random_seed: u32,
    selectors: [Selector; 1],
    properties: Properties,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Selector {
    id: String,
    name: &'static str,
    kind: &'static str,
    enabled: bool,
    mode: &'static str,
    amount: StaticProperty,
    based_on: &'static str,
    expression: String,
}
#[derive(Serialize)]
struct Properties {
    position: [StaticProperty; 3],
    scale: [StaticProperty; 3],
    opacity: StaticProperty,
}
impl RuntimeProjectDocument {
    pub(super) fn text(document: &mut Object) -> Result<(), ProjectError> {
        for composition in Self::compositions(document) {
            for layer in Self::layers(composition) {
                let Some(legacy) = layer.get("textAnimator").and_then(Json::object) else {
                    continue;
                };
                if legacy.get("groups").and_then(Json::array).is_some() {
                    continue;
                }
                let id = layer
                    .get("id")
                    .and_then(Json::string)
                    .unwrap_or("text-layer");
                let delay = legacy.bounded("delay", -60.0, 60.0, 0.0);
                let stagger = legacy.bounded("stagger", 0.0, 10.0, 0.04);
                let duration = legacy.bounded("duration", 0.01, 60.0, 0.5);
                let position = legacy.get("position").and_then(Json::array).unwrap_or(&[]);
                let x = position
                    .first()
                    .and_then(Json::finite)
                    .unwrap_or(0.0)
                    .clamp(-8192.0, 8192.0);
                let y = position
                    .get(1)
                    .and_then(Json::finite)
                    .unwrap_or(64.0)
                    .clamp(-8192.0, 8192.0);
                let scale = legacy.bounded("scale", 0.0, 1000.0, 80.0);
                let opacity = legacy.bounded("opacity", 0.0, 100.0, 0.0);
                let expression = format!(
                    "100 * pow(1 - clamp((time - {} - (textIndex - 1) * {}) / {}, 0, 1), 3)",
                    ryu_js::Buffer::new().format(delay),
                    ryu_js::Buffer::new().format(stagger),
                    ryu_js::Buffer::new().format(duration)
                );
                let stack = Stack {
                    enabled: legacy.get("enabled").is_some_and(Json::truthy),
                    groups: [Group {
                        id: format!("{id}:animator:1"),
                        name: "Animator 1",
                        enabled: true,
                        random_seed: 0,
                        selectors: [Selector {
                            id: format!("{id}:selector:1"),
                            name: "Expression Selector 1",
                            kind: "expression",
                            enabled: true,
                            mode: "add",
                            amount: StaticProperty::at(100.0),
                            based_on: "characters",
                            expression,
                        }],
                        properties: Properties {
                            position: [
                                StaticProperty::at(x),
                                StaticProperty::at(y),
                                StaticProperty::at(0.0),
                            ],
                            scale: [
                                StaticProperty::at(scale),
                                StaticProperty::at(scale),
                                StaticProperty::at(100.0),
                            ],
                            opacity: StaticProperty::at(opacity),
                        },
                    }],
                };
                layer.set("textAnimator", Json::typed(&stack)?);
            }
        }
        Ok(())
    }
}
