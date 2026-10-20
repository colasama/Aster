use super::{CameraPose, CameraProjection};
use crate::vector::Vector3;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct CameraBasis {
    pub right: [f64; 3],
    pub down: [f64; 3],
    pub forward: [f64; 3],
}

impl CameraPose {
    pub fn basis(&self) -> CameraBasis {
        let forward = if self.mode == "twoNode" {
            Vector3(self.point_of_interest)
                .finite()
                .subtract(Vector3(self.position).finite())
                .normalize(Vector3([0.0, 0.0, 1.0]))
        } else {
            Vector3([0.0, 0.0, 1.0])
        };
        let reference = if forward.dot(Vector3([0.0, 1.0, 0.0])).abs() > 0.999 {
            Vector3([0.0, 0.0, 1.0])
        } else {
            Vector3([0.0, 1.0, 0.0])
        };
        let right = reference.cross(forward).normalize(Vector3([1.0, 0.0, 0.0]));
        let down = forward.cross(right).normalize(Vector3([0.0, 1.0, 0.0]));
        let rotation = Vector3(self.orientation)
            .finite()
            .add(Vector3(self.rotation).finite())
            .0;
        let mut basis = CameraBasis {
            right: right.0,
            down: down.0,
            forward: forward.0,
        };
        basis.rotate(Vector3(basis.right), rotation[0]);
        basis.rotate(Vector3(basis.down), rotation[1]);
        basis.rotate(Vector3(basis.forward), rotation[2]);
        let right = Vector3(basis.right).normalize(Vector3([1.0, 0.0, 0.0]));
        let forward = Vector3(basis.forward).normalize(Vector3([0.0, 0.0, 1.0]));
        let down = forward.cross(right).normalize(Vector3([0.0, 1.0, 0.0]));
        let right = down.cross(forward).normalize(Vector3([1.0, 0.0, 0.0]));
        CameraBasis {
            right: right.0,
            down: down.0,
            forward: forward.0,
        }
    }
}

impl CameraBasis {
    fn rotate(&mut self, axis: Vector3, degrees: f64) {
        if degrees.abs() <= 1e-6 {
            return;
        }
        self.right = Vector3(self.right).rotate_axis(axis, degrees).0;
        self.down = Vector3(self.down).rotate_axis(axis, degrees).0;
        self.forward = Vector3(self.forward).rotate_axis(axis, degrees).0;
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedCameraPoint {
    pub screen: [f64; 2],
    pub camera_depth: f64,
    pub normalized_depth: f64,
    pub visible: bool,
}

#[derive(Clone, Debug)]
pub struct CameraProjector {
    size: [f64; 2],
    basis: CameraBasis,
    position: Vector3,
    near: f64,
    far: f64,
    perspective: bool,
    zoom: f64,
    orthographic_scale: f64,
    depth_range: f64,
    perspective_offset: f64,
    perspective_product: f64,
}

impl CameraProjector {
    pub fn new(pose: &CameraPose, projection: &CameraProjection, size: [f64; 2]) -> Self {
        let width = Self::positive(size[0], 1.0);
        let height = Self::positive(size[1], 1.0);
        let near = Self::positive(projection.near, 0.01);
        let far = (near + 1e-6).max(Self::positive(projection.far, 1_000_000.0));
        let depth_range = far - near;
        Self {
            size: [width, height],
            basis: pose.basis(),
            position: Vector3(pose.position).finite(),
            near,
            far,
            perspective: projection.kind == "perspective",
            zoom: Self::positive(projection.zoom, 1.0),
            orthographic_scale: height / Self::positive(projection.orthographic_size, height),
            depth_range,
            perspective_offset: far / depth_range,
            perspective_product: far * near,
        }
    }
    fn positive(value: f64, fallback: f64) -> f64 {
        if value.is_finite() && value > 0.0 {
            value
        } else {
            fallback
        }
    }
    pub fn project(&self, point: [f64; 3]) -> ProjectedCameraPoint {
        let relative = Vector3(point).finite().subtract(self.position);
        let depth = relative.dot(Vector3(self.basis.forward));
        let scale = if self.perspective {
            self.zoom / depth.max(1e-6)
        } else {
            self.orthographic_scale
        };
        let screen = [
            self.size[0] * 0.5 + relative.dot(Vector3(self.basis.right)) * scale,
            self.size[1] * 0.5 + relative.dot(Vector3(self.basis.down)) * scale,
        ];
        let normalized_depth = if self.perspective {
            self.perspective_offset
                - self.perspective_product / (self.depth_range * depth.max(1e-6))
        } else {
            (depth - self.near) / self.depth_range
        };
        ProjectedCameraPoint {
            screen,
            camera_depth: depth,
            normalized_depth,
            visible: depth >= self.near
                && depth <= self.far
                && screen[0] >= 0.0
                && screen[0] <= self.size[0]
                && screen[1] >= 0.0
                && screen[1] <= self.size[1],
        }
    }
}
