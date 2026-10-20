use crate::EvaluatedTransform;

impl EvaluatedTransform {
    pub(super) fn compose_parent(&self, world: &Self) -> Self {
        let scale_x = world.scale[0] / 100.;
        let scale_y = world.scale[1] / 100.;
        let radians = (world.rotation[2] * std::f64::consts::PI) / 180.;
        let local_x = self.position[0] * scale_x;
        let local_y = self.position[1] * scale_y;
        Self {
            position: [
                world.position[0] + local_x * radians.cos() - local_y * radians.sin(),
                world.position[1] + local_x * radians.sin() + local_y * radians.cos(),
                world.position[2] + self.position[2] * (world.scale[2] / 100.),
            ],
            rotation: std::array::from_fn(|index| {
                self.rotation[index]
                    * if index == 2 && scale_x * scale_y < 0. {
                        -1.
                    } else {
                        1.
                    }
                    + world.rotation[index]
            }),
            scale: std::array::from_fn(|index| (self.scale[index] * world.scale[index]) / 100.),
            anchor: self.anchor,
            opacity: self.opacity * world.opacity,
        }
    }

    pub(super) fn wrapper_size(&self, size: [f64; 2], nested_size: [f64; 2]) -> Self {
        let offset_x = ((size[0] / 2. - self.anchor[0]) * self.scale[0]) / 100.;
        let offset_y = ((size[1] / 2. - self.anchor[1]) * self.scale[1]) / 100.;
        let radians = (self.rotation[2] * std::f64::consts::PI) / 180.;
        Self {
            position: [
                self.position[0] + offset_x * radians.cos() - offset_y * radians.sin(),
                self.position[1] + offset_x * radians.sin() + offset_y * radians.cos(),
                self.position[2] - (self.anchor[2] * self.scale[2]) / 100.,
            ],
            scale: [
                self.scale[0] * (size[0] / nested_size[0]),
                self.scale[1] * (size[1] / nested_size[1]),
                self.scale[2],
            ],
            ..self.clone()
        }
    }

    pub(super) fn map_nested(&self, parent: &Self, source_size: [f64; 2]) -> Self {
        let mut centered = self.clone();
        centered.position[0] -= source_size[0] / 2.;
        centered.position[1] -= source_size[1] / 2.;
        centered.compose_parent(parent)
    }
}
