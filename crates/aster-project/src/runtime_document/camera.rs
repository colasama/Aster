use super::{Json, Object, RuntimeProjectDocument, StaticProperty};
use crate::ProjectError;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyCamera {
    mode: &'static str,
    projection: &'static str,
    zoom: f64,
    film_size: f64,
    focal_length: f64,
    orthographic_size: f64,
    point_of_interest: [StaticProperty; 3],
    orientation: [StaticProperty; 3],
    depth_of_field: bool,
    focus_distance: f64,
    lock_focus_to_zoom: bool,
    aperture: f64,
    f_stop: f64,
    blur_level: f64,
    focus_area_width: f64,
    near_blur_level: f64,
    far_blur_level: f64,
    render_quality: f64,
}
impl RuntimeProjectDocument {
    pub(super) fn cameras(document: &mut Object, version: u64) -> Result<(), ProjectError> {
        for composition in Self::compositions(document) {
            let width = composition.number("width", 1920.0);
            let width = if width > 0.0 { width } else { 1920.0 };
            let height = composition.number("height", 1080.0);
            let height = if height > 0.0 { height } else { 1080.0 };
            for layer in Self::layers(composition) {
                if layer.get("kind").and_then(Json::string) != Some("camera") {
                    continue;
                }
                let Some(legacy) = layer.get("camera").and_then(Json::object) else {
                    continue;
                };
                if version == 5 {
                    if matches!(legacy.get("zoom"), Some(Json::Number(_))) {
                        continue;
                    }
                    let field_of_view = legacy.bounded("fieldOfView", 1.0, 179.0, 50.0);
                    let zoom =
                        height / (2.0 * (field_of_view * std::f64::consts::PI / 360.0).tan());
                    let focal_length = zoom * 36.0 / width;
                    let camera = LegacyCamera {
                        mode: "oneNode",
                        projection: if legacy.get("projection").and_then(Json::string)
                            == Some("orthographic")
                        {
                            "orthographic"
                        } else {
                            "perspective"
                        },
                        zoom,
                        film_size: 36.0,
                        focal_length,
                        orthographic_size: legacy.bounded(
                            "orthographicSize",
                            1.0,
                            10_000_000.0,
                            height,
                        ),
                        point_of_interest: [
                            StaticProperty::at(width * 0.5),
                            StaticProperty::at(height * 0.5),
                            StaticProperty::at(0.0),
                        ],
                        orientation: [StaticProperty::at(0.0); 3],
                        depth_of_field: false,
                        focus_distance: zoom,
                        lock_focus_to_zoom: true,
                        aperture: focal_length / 2.8,
                        f_stop: 2.8,
                        blur_level: 100.0,
                        focus_area_width: 0.0,
                        near_blur_level: 100.0,
                        far_blur_level: 100.0,
                        render_quality: 50.0,
                    };
                    layer.set("camera", Json::typed(&camera)?);
                    if let Some(position) = layer
                        .get_mut("transform")
                        .and_then(Json::object_mut)
                        .and_then(|t| t.get_mut("position"))
                        .and_then(Json::array_mut)
                        .filter(|p| p.len() == 3)
                    {
                        Self::offset_property(&mut position[2], -zoom)?;
                    }
                } else {
                    let zoom = legacy.bounded("zoom", 0.1, 1_000_000.0, 2_666.666_666_666_666_5);
                    let f_stop = legacy.bounded("fStop", 0.1, 1_000.0, 2.8);
                    let film_size = legacy.bounded("filmSize", 0.1, 1_000.0, 36.0);
                    let focal_length =
                        legacy.bounded("focalLength", 0.1, 10_000.0, zoom * film_size / width);
                    let mut camera = legacy.clone();
                    for (key, value) in [
                        ("zoom", zoom),
                        ("filmSize", film_size),
                        (
                            "orthographicSize",
                            legacy.bounded("orthographicSize", 1.0, 10_000_000.0, height),
                        ),
                        (
                            "focusDistance",
                            legacy.bounded("focusDistance", 0.1, 10_000_000.0, zoom),
                        ),
                        ("aperture", (focal_length / f_stop) * (72.0 / 25.4)),
                        (
                            "blurLevel",
                            legacy.bounded("blurLevel", 0.0, 1_000.0, 100.0),
                        ),
                        (
                            "focusAreaWidth",
                            legacy.bounded("focusAreaWidth", 0.0, 10_000_000.0, 0.0),
                        ),
                        (
                            "nearBlurLevel",
                            legacy.bounded("nearBlurLevel", 0.0, 1_000.0, 100.0),
                        ),
                        (
                            "farBlurLevel",
                            legacy.bounded("farBlurLevel", 0.0, 1_000.0, 100.0),
                        ),
                        ("irisRotation", 0.0),
                        ("irisRoundness", 0.0),
                        ("irisAspectRatio", 1.0),
                        ("irisDiffractionFringe", 0.0),
                        ("highlightGain", 0.0),
                        ("highlightThreshold", 1.0),
                        ("highlightSaturation", 100.0),
                    ] {
                        camera.set(key, Json::typed(&StaticProperty::at(value))?);
                    }
                    camera.set("irisShape", Json::String("fastRectangle".into()));
                    camera.remove("focalLength");
                    camera.remove("fStop");
                    if !matches!(layer.get("visible"), Some(Json::Bool(_))) {
                        layer.set("visible", Json::Bool(true));
                    }
                    layer.set("camera", Json::Object(camera));
                }
            }
        }
        Ok(())
    }
    fn offset_property(value: &mut Json, offset: f64) -> Result<(), ProjectError> {
        if matches!(value, Json::Array(_)) {
            return Ok(());
        }
        let Some(property) = value.object_mut() else {
            *value = Json::typed(&StaticProperty::at(offset))?;
            return Ok(());
        };
        match property.get("mode").and_then(Json::string) {
            Some("static") => {
                property.set(
                    "value",
                    Json::typed(&(property.number("value", 0.0) + offset))?,
                );
            }
            Some("animated") => {
                if let Some(keyframes) = property.get_mut("keyframes").and_then(Json::array_mut) {
                    for keyframe in keyframes.iter_mut().filter_map(Json::object_mut) {
                        keyframe.set(
                            "value",
                            Json::typed(&(keyframe.number("value", 0.0) + offset))?,
                        );
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
}
