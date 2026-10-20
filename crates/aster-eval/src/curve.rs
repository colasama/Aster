#[derive(Clone, Copy, Debug)]
pub(crate) struct CubicBezier {
    pub controls: [f64; 4],
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct TemporalSample {
    pub value: f64,
    pub slope: f64,
}

impl CubicBezier {
    pub fn sample(self, progress: f64) -> TemporalSample {
        let [x1, y1, x2, y2] = self.controls;
        let mut parameter = progress;
        for _ in 0..6 {
            let error = Self::unit_value(parameter, x1, x2) - progress;
            let slope = Self::unit_derivative(parameter, x1, x2);
            if slope.abs() < 1e-7 {
                break;
            }
            parameter = (parameter - error / slope).clamp(0.0, 1.0);
        }
        let x_slope = Self::unit_derivative(parameter, x1, x2);
        let y_slope = Self::unit_derivative(parameter, y1, y2);
        TemporalSample {
            value: Self::unit_value(parameter, y1, y2),
            slope: if x_slope.abs() < 1e-9 {
                0.0
            } else {
                y_slope / x_slope
            },
        }
    }

    fn unit_value(time: f64, first: f64, second: f64) -> f64 {
        let inverse = 1.0 - time;
        3.0 * inverse * inverse * time * first
            + 3.0 * inverse * time * time * second
            + time * time * time
    }

    fn unit_derivative(time: f64, first: f64, second: f64) -> f64 {
        3.0 * (1.0 - time).powi(2) * first
            + 6.0 * (1.0 - time) * time * (second - first)
            + 3.0 * time.powi(2) * (1.0 - second)
    }

    pub fn spatial_value(time: f64, start: f64, first: f64, second: f64, end: f64) -> f64 {
        let inverse = 1.0 - time;
        inverse.powi(3) * start
            + 3.0 * inverse * inverse * time * first
            + 3.0 * inverse * time * time * second
            + time.powi(3) * end
    }

    pub fn spatial_derivative(time: f64, start: f64, first: f64, second: f64, end: f64) -> f64 {
        let inverse = 1.0 - time;
        3.0 * inverse * inverse * (first - start)
            + 6.0 * inverse * time * (second - first)
            + 3.0 * time * time * (end - second)
    }
}
