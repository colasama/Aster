use crate::{CameraTrack, EvaluatedCamera, EvaluatedTransform, EvaluationError, EvaluationLimits};
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorContext {
    pub composition_size: [f64; 2],
    pub render_size: [f64; 2],
    pub composition_time: f64,
    pub source_time: f64,
    pub frame_duration: f64,
    pub transform: EvaluatedTransform,
    pub selection_id: String,
    pub layer_kind: String,
    pub three_dimensional: bool,
    pub camera: Option<EvaluatedCamera>,
}

impl GeneratorContext {
    pub fn pack(&self, count: u32) -> Result<Vec<u32>, EvaluationError> {
        let [width, height] = self.render_size;
        let [composition_width, composition_height] = self.composition_size;
        if [width, height, composition_width, composition_height]
            .iter()
            .any(|n| !n.is_finite() || *n <= 0.)
        {
            return Err(EvaluationError::InvalidScene(
                "invalid generator context dimensions".into(),
            ));
        }
        let default_camera;
        let camera = match &self.camera {
            Some(camera) => camera,
            None => {
                default_camera = CameraTrack::default_evaluated(
                    self.composition_size,
                    &EvaluationLimits::default(),
                )?;
                &default_camera
            }
        };
        let mut data = vec![0_f32; 52];
        data[..6].copy_from_slice(
            &[
                width,
                height,
                self.composition_time,
                self.source_time,
                self.frame_duration,
                0.,
            ]
            .map(|n| n as f32),
        );
        let transform = &self.transform;
        data[8..11].copy_from_slice(&transform.position.map(|n| n as f32));
        data[11] = transform.opacity as f32;
        data[12..15].copy_from_slice(&transform.rotation.map(|n| n as f32));
        data[15] = u32::from(self.three_dimensional) as f32;
        data[16..19].copy_from_slice(&transform.scale.map(|n| n as f32));
        data[20..23].copy_from_slice(&camera.pose.position.map(|n| n as f32));
        data[24..27].copy_from_slice(&camera.pose.rotation.map(|n| n as f32));
        data[28..32].copy_from_slice(
            &[
                if camera.optics.projection == "orthographic" {
                    1.
                } else {
                    0.
                },
                2. * (composition_width / (2. * camera.optics.zoom)).atan(),
                camera.projection.orthographic_size,
                camera.optics.zoom,
            ]
            .map(|n| n as f32),
        );
        data[32..35].copy_from_slice(
            &[
                composition_width,
                composition_height,
                width / height.max(1.),
            ]
            .map(|n| n as f32),
        );
        let basis = camera.pose.basis();
        for (offset, vector) in [(40, basis.right), (44, basis.down), (48, basis.forward)] {
            data[offset..offset + 3].copy_from_slice(&vector.map(|n| n as f32));
        }
        if data.iter().any(|n| !n.is_finite()) {
            return Err(EvaluationError::InvalidScene(
                "nonfinite generator context".into(),
            ));
        }
        let mut bits: Vec<_> = data.into_iter().map(f32::to_bits).collect();
        bits[6] = count;
        bits[7] = Self::render_id(&self.selection_id);
        bits[36] = bits[7];
        bits[37] = Self::render_id(&format!("material:{}", self.layer_kind));
        Ok(bits)
    }
    fn render_id(value: &str) -> u32 {
        let hash = value.encode_utf16().fold(0x811c9dc5u32, |hash, c| {
            (hash ^ u32::from(c)).wrapping_mul(0x01000193)
        });
        if hash == 0 { 1 } else { hash }
    }
}
