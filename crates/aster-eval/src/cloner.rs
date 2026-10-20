mod compile;
mod effector;

use crate::{EvaluatedTransform, EvaluationError, vector::Vector3};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug, clap::Args)]
pub struct ClonerLimits {
    #[arg(long, default_value_t = Self::default().max_cloner_instances)]
    pub max_cloner_instances: usize,
    #[arg(long, default_value_t = Self::default().max_cloner_effectors)]
    pub max_cloner_effectors: usize,
}

impl Default for ClonerLimits {
    fn default() -> Self {
        Self {
            max_cloner_instances: 65536,
            max_cloner_effectors: 32,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ClonerInstance {
    pub index: usize,
    pub position: [f64; 3],
    pub rotation: [f64; 3],
    pub scale: [f64; 3],
}

impl ClonerInstance {
    pub fn compose(&self, source: &EvaluatedTransform) -> EvaluatedTransform {
        let offset = Vector3(std::array::from_fn(|i| {
            self.position[i] * source.scale[i] / 100.
        }))
        .rotate_euler(source.rotation)
        .0;
        EvaluatedTransform {
            position: std::array::from_fn(|i| source.position[i] + offset[i]),
            rotation: std::array::from_fn(|i| source.rotation[i] + self.rotation[i]),
            scale: std::array::from_fn(|i| source.scale[i] * self.scale[i] / 100.),
            anchor: source.anchor,
            opacity: source.opacity,
        }
    }

    fn random(seed: u32, index: usize, channel: u32) -> f64 {
        let mut value = seed
            ^ (index as u32 + 1).wrapping_mul(0x9e3779b1)
            ^ (channel + 1).wrapping_mul(0x85ebca6b);
        value ^= value >> 16;
        value = value.wrapping_mul(0x7f4a7c15);
        value ^= value >> 15;
        value = value.wrapping_mul(0x846ca68b);
        value ^= value >> 16;
        f64::from(value) / f64::from(u32::MAX)
    }
}

#[derive(Clone, Debug)]
pub struct ClonerFrame {
    pub instances: Arc<[ClonerInstance]>,
}

impl ClonerFrame {
    pub fn instance_data(&self) -> Vec<f32> {
        let mut data = vec![0.; self.instances.len() * 16];
        let divisor = self.instances.len().saturating_sub(1).max(1) as f64;
        for (i, instance) in self.instances.iter().enumerate() {
            let row = &mut data[i * 16..(i + 1) * 16];
            for axis in 0..3 {
                row[axis] = instance.position[axis] as f32;
                row[axis + 4] = (instance.rotation[axis] * std::f64::consts::PI / 180.) as f32;
                row[axis + 8] = (instance.scale[axis] / 100.) as f32;
            }
            row[12] = instance.index as f32;
            row[13] = (i as f64 / divisor) as f32;
            row[14] = ClonerInstance::random(0x41535452, instance.index, 0) as f32;
            row[15] = 1.;
        }
        data
    }
}

#[derive(Clone, Debug)]
pub struct ClonerTrack {
    base: Arc<[ClonerInstance]>,
    silent: ClonerFrame,
    effectors: Vec<effector::Effector>,
    has_audio: bool,
}

impl ClonerTrack {
    pub fn evaluate(
        &self,
        time: f64,
        spectrum: Option<&[f32]>,
    ) -> Result<ClonerFrame, EvaluationError> {
        if !time.is_finite() {
            return Err(EvaluationError::InvalidTime);
        }
        if !self.has_audio || spectrum.is_none() {
            return Ok(self.silent.clone());
        }
        let mut instances = self.base.to_vec();
        for effector in &self.effectors {
            effector.apply(&mut instances, spectrum);
        }
        Ok(ClonerFrame {
            instances: instances.into(),
        })
    }
}
