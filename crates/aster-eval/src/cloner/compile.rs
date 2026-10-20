use super::{
    ClonerFrame, ClonerInstance, ClonerLimits, ClonerTrack,
    effector::{Effector, Kind},
};
use crate::EvaluationError;
use aster_types::editor::{Cloner, ClonerDistribution, ClonerEffectorKind};
use serde_json::Number;
use std::sync::Arc;

impl ClonerTrack {
    pub fn compile(settings: &Cloner, limits: &ClonerLimits) -> Result<Self, EvaluationError> {
        if settings.effectors.len() > limits.max_cloner_effectors.min(32) {
            return Err(Self::invalid("effector budget exceeded"));
        }
        let maximum = limits.max_cloner_instances.min(65536);
        let base: Arc<[ClonerInstance]> = match &settings.distribution {
            ClonerDistribution::Grid { count, spacing, .. } => {
                let count = Self::numbers(count, 1., 512.)?;
                if count.iter().any(|n| n.fract() != 0.) {
                    return Err(Self::invalid("noninteger grid count"));
                }
                let count = count.map(|n| n as usize);
                let length = count.iter().product::<usize>();
                if length > maximum {
                    return Err(Self::invalid("instance budget exceeded"));
                }
                let spacing = Self::numbers(spacing, -1e6, 1e6)?;
                let center: [f64; 3] =
                    std::array::from_fn(|i| (count[i] - 1) as f64 * spacing[i] / 2.);
                let mut instances = Vec::with_capacity(length);
                for z in 0..count[2] {
                    for y in 0..count[1] {
                        for x in 0..count[0] {
                            let cell = [x, y, z];
                            instances.push(ClonerInstance {
                                index: instances.len(),
                                position: std::array::from_fn(|i| {
                                    cell[i] as f64 * spacing[i] - center[i]
                                }),
                                rotation: [0.; 3],
                                scale: [100.; 3],
                            });
                        }
                    }
                }
                instances.into()
            }
            ClonerDistribution::Radial {
                count,
                radius,
                start_angle,
                end_angle,
                axis,
                align_rotation,
                ..
            } => {
                let count = Self::number(count, 1., maximum as f64)?;
                if count.fract() != 0. {
                    return Err(Self::invalid("noninteger radial count"));
                }
                let count = count as usize;
                let radius = Self::number(radius, 0., 1e6)?;
                let start = Self::number(start_angle, -1e6, 1e6)?;
                let end = Self::number(end_angle, -1e6, 1e6)?;
                let axis = match axis.as_str() {
                    "x" => 0,
                    "y" => 1,
                    "z" => 2,
                    _ => return Err(Self::invalid("invalid radial axis")),
                };
                let denominator = if count <= 1 {
                    1
                } else if (end - start).abs() >= 360. - 0.000001 {
                    count
                } else {
                    count - 1
                } as f64;
                (0..count)
                    .map(|index| {
                        let angle = start + (end - start) * index as f64 / denominator;
                        let radians = angle * std::f64::consts::PI / 180.;
                        let cosine = radians.cos() * radius;
                        let sine = radians.sin() * radius;
                        let mut rotation = [0.; 3];
                        if *align_rotation {
                            rotation[axis] = angle;
                        }
                        ClonerInstance {
                            index,
                            position: match axis {
                                0 => [0., cosine, sine],
                                1 => [cosine, 0., sine],
                                _ => [cosine, sine, 0.],
                            },
                            rotation,
                            scale: [100.; 3],
                        }
                    })
                    .collect::<Vec<_>>()
                    .into()
            }
        };
        let mut effectors = Vec::with_capacity(settings.effectors.len());
        for effector in &settings.effectors {
            if effector.id.is_empty() {
                return Err(Self::invalid("empty effector id"));
            }
            let strength = Self::number(&effector.strength, -10., 10.)?;
            let kind = match &effector.kind {
                ClonerEffectorKind::Position { value, .. } => {
                    Kind::Position(Self::numbers(value, -1e6, 1e6)?)
                }
                ClonerEffectorKind::Rotation { value, .. } => {
                    Kind::Rotation(Self::numbers(value, -1e6, 1e6)?)
                }
                ClonerEffectorKind::Scale { value, .. } => {
                    let value = Self::numbers(value, 0., 10000.)?;
                    if value.iter().any(|n| *n <= 0.) {
                        return Err(Self::invalid("nonpositive effector scale"));
                    }
                    Kind::Scale(value)
                }
                ClonerEffectorKind::Random {
                    seed,
                    position,
                    scale,
                    rotation,
                    ..
                } => {
                    let seed = Self::number(seed, 0., f64::from(u32::MAX))?;
                    if seed.fract() != 0. {
                        return Err(Self::invalid("noninteger random seed"));
                    }
                    Kind::Random {
                        seed: seed as u32,
                        position: Self::numbers(position, 0., 1e6)?,
                        scale: Self::numbers(scale, 0., 1e6)?,
                        rotation: Self::numbers(rotation, 0., 1e6)?,
                    }
                }
                ClonerEffectorKind::Audio {
                    band,
                    gain,
                    position,
                    scale,
                    rotation,
                    ..
                } => {
                    let band = Self::numbers(band, 0., 192000.)?;
                    if band[1] < band[0] {
                        return Err(Self::invalid("reversed audio band"));
                    }
                    Kind::Audio {
                        band,
                        gain: Self::number(gain, 0., 100.)?,
                        position: Self::numbers(position, -1e6, 1e6)?,
                        scale: Self::numbers(scale, -1e6, 1e6)?,
                        rotation: Self::numbers(rotation, -1e6, 1e6)?,
                    }
                }
            };
            effectors.push(Effector {
                enabled: effector.enabled,
                strength,
                kind,
            });
        }
        let has_audio = effectors
            .iter()
            .any(|e| matches!(e.kind, Kind::Audio { .. }) && e.enabled && e.strength != 0.);
        let mut silent = base.to_vec();
        for effector in &effectors {
            effector.apply(&mut silent, None);
        }
        Ok(Self {
            base,
            effectors,
            has_audio,
            silent: ClonerFrame {
                instances: silent.into(),
            },
        })
    }

    fn numbers<const N: usize>(
        values: &[Number; N],
        min: f64,
        max: f64,
    ) -> Result<[f64; N], EvaluationError> {
        let mut output = [0.; N];
        for (result, value) in output.iter_mut().zip(values) {
            *result = Self::number(value, min, max)?;
        }
        Ok(output)
    }

    fn number(value: &Number, min: f64, max: f64) -> Result<f64, EvaluationError> {
        value
            .as_f64()
            .filter(|n| n.is_finite() && *n >= min && *n <= max)
            .ok_or_else(|| Self::invalid("number outside supported range"))
    }

    fn invalid(message: &str) -> EvaluationError {
        EvaluationError::InvalidScene(format!("cloner: {message}"))
    }
}
