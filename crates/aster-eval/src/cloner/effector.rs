use super::ClonerInstance;

#[derive(Clone, Debug)]
pub(super) enum Kind {
    Position([f64; 3]),
    Scale([f64; 3]),
    Rotation([f64; 3]),
    Random {
        seed: u32,
        position: [f64; 3],
        scale: [f64; 3],
        rotation: [f64; 3],
    },
    Audio {
        band: [f64; 2],
        gain: f64,
        position: [f64; 3],
        scale: [f64; 3],
        rotation: [f64; 3],
    },
}

#[derive(Clone, Debug)]
pub(super) struct Effector {
    pub enabled: bool,
    pub strength: f64,
    pub kind: Kind,
}

impl Effector {
    pub fn apply(&self, instances: &mut [ClonerInstance], spectrum: Option<&[f32]>) {
        if !self.enabled || self.strength == 0. {
            return;
        }
        let audio = match &self.kind {
            Kind::Audio { band, gain, .. } => {
                (Self::spectrum(spectrum, *band) * gain).clamp(0., 1000.) * self.strength
            }
            _ => 0.,
        };
        for instance in instances {
            for axis in 0..3 {
                match &self.kind {
                    Kind::Position(value) => instance.position[axis] += value[axis] * self.strength,
                    Kind::Rotation(value) => instance.rotation[axis] += value[axis] * self.strength,
                    Kind::Scale(value) => {
                        instance.scale[axis] = (instance.scale[axis]
                            * (1. + (value[axis] / 100. - 1.) * self.strength))
                            .max(0.001)
                    }
                    Kind::Audio {
                        position,
                        scale,
                        rotation,
                        ..
                    } => {
                        instance.position[axis] += position[axis] * audio;
                        instance.scale[axis] =
                            (instance.scale[axis] * (1. + scale[axis] * audio / 100.)).max(0.001);
                        instance.rotation[axis] += rotation[axis] * audio;
                    }
                    Kind::Random {
                        seed,
                        position,
                        scale,
                        rotation,
                    } => {
                        let signed = |channel| {
                            ClonerInstance::random(*seed, instance.index, channel) * 2. - 1.
                        };
                        instance.position[axis] +=
                            signed(axis as u32) * position[axis].abs() * self.strength;
                        instance.scale[axis] = (instance.scale[axis]
                            * (1.
                                + signed(axis as u32 + 3) * scale[axis].abs() * self.strength
                                    / 100.))
                            .max(0.001);
                        instance.rotation[axis] +=
                            signed(axis as u32 + 6) * rotation[axis].abs() * self.strength;
                    }
                }
            }
        }
    }

    fn spectrum(spectrum: Option<&[f32]>, band: [f64; 2]) -> f64 {
        let mut sum = 0.;
        let mut count = 0;
        if let Some(spectrum) = spectrum {
            for row in spectrum.chunks_exact(4).take(16385) {
                let frequency = f64::from(row[0]);
                if !frequency.is_finite() || frequency < band[0] || frequency > band[1] {
                    continue;
                }
                sum += if row[1].is_finite() {
                    f64::from(row[1]).clamp(0., 1000.)
                } else {
                    0.
                };
                count += 1;
            }
        }
        if count == 0 {
            0.
        } else {
            sum / f64::from(count)
        }
    }
}
