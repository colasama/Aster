#[derive(Clone, Copy, Debug)]
pub(crate) struct Vector3(pub [f64; 3]);

impl Vector3 {
    pub fn rotate_euler(self, degrees: [f64; 3]) -> Self {
        let [rx, ry, rz] = degrees.map(|value| value * std::f64::consts::PI / 180.0);
        let [mut x, mut y, mut z] = self.0;
        (y, z) = (y * rx.cos() - z * rx.sin(), y * rx.sin() + z * rx.cos());
        (x, z) = (x * ry.cos() + z * ry.sin(), -x * ry.sin() + z * ry.cos());
        (x, y) = (x * rz.cos() - y * rz.sin(), x * rz.sin() + y * rz.cos());
        Self([x, y, z])
    }
    pub fn unit_or_zero(self) -> Self {
        let magnitude = self.0[0].hypot(self.0[1]).hypot(self.0[2]);
        let divisor = if magnitude == 0.0 { 1.0 } else { magnitude };
        Self(self.0.map(|value| value / divisor))
    }
    pub fn finite(self) -> Self {
        Self(
            self.0
                .map(|value| if value.is_finite() { value } else { 0.0 }),
        )
    }
    pub fn add(self, other: Self) -> Self {
        Self(std::array::from_fn(|i| self.0[i] + other.0[i]))
    }
    pub fn subtract(self, other: Self) -> Self {
        Self(std::array::from_fn(|i| self.0[i] - other.0[i]))
    }
    pub fn scale(self, amount: f64) -> Self {
        Self(self.0.map(|value| value * amount))
    }
    pub fn dot(self, other: Self) -> f64 {
        self.0[0] * other.0[0] + self.0[1] * other.0[1] + self.0[2] * other.0[2]
    }
    pub fn cross(self, other: Self) -> Self {
        let [x, y, z] = self.0;
        let [a, b, c] = other.0;
        Self([y * c - z * b, z * a - x * c, x * b - y * a])
    }
    pub fn normalize(self, fallback: Self) -> Self {
        let magnitude = self.0[0].hypot(self.0[1]).hypot(self.0[2]);
        if magnitude > 1e-6 && magnitude.is_finite() {
            self.scale(1.0 / magnitude)
        } else {
            fallback.finite()
        }
    }
    pub fn rotate_axis(self, axis: Self, degrees: f64) -> Self {
        let axis = axis.normalize(Self([1.0, 0.0, 0.0]));
        let degrees = if degrees.is_finite() { degrees } else { 0.0 };
        let radians = (degrees * std::f64::consts::PI) / 180.0;
        self.scale(radians.cos())
            .add(axis.cross(self).scale(radians.sin()))
            .add(axis.scale(axis.dot(self) * (1.0 - radians.cos())))
    }
}
