use super::{PathTessellator, Point2, TrimmedPolyline};
use crate::EvaluationError;

impl PathTessellator {
    pub fn trim(
        &mut self,
        input: &[Point2],
        closed: bool,
        start: f64,
        end: f64,
        offset: f64,
    ) -> Result<Vec<TrimmedPolyline>, EvaluationError> {
        let points = self.deduplicate(input)?;
        if points.len() < 2 {
            return Ok(Vec::new());
        }
        let start = if start.is_finite() {
            start.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let end = if end.is_finite() {
            end.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let span = if end >= start {
            end - start
        } else {
            1.0 - start + end
        };
        if span >= 1.0 - 1e-7 {
            return Ok(vec![TrimmedPolyline { points, closed }]);
        }
        if span <= 1e-7 {
            return Ok(Vec::new());
        }
        if !offset.is_finite() {
            return Err(EvaluationError::InvalidScene("invalid trim offset".into()));
        }
        let shifted_start = (((start + offset) % 1.0) + 1.0) % 1.0;
        let shifted_end = shifted_start + span;
        if shifted_end <= 1.0 + 1e-7 {
            let points = self.slice(&points, closed, shifted_start, shifted_end.min(1.0))?;
            return Ok(if points.len() < 2 {
                Vec::new()
            } else {
                vec![TrimmedPolyline {
                    points,
                    closed: false,
                }]
            });
        }
        let mut tail = self.slice(&points, closed, shifted_start, 1.0)?;
        let head = self.slice(&points, closed, 0.0, shifted_end - 1.0)?;
        if !closed {
            return Ok([tail, head]
                .into_iter()
                .filter(|p| p.len() >= 2)
                .map(|points| TrimmedPolyline {
                    points,
                    closed: false,
                })
                .collect());
        }
        let skip = usize::from(
            tail.last()
                .zip(head.first())
                .is_some_and(|(a, b)| a.distance_squared(*b) <= 1e-7),
        );
        self.append(&mut tail, &head[skip..], self.limits.max_flattened_points)?;
        Ok(if tail.len() < 2 {
            Vec::new()
        } else {
            vec![TrimmedPolyline {
                points: tail,
                closed: false,
            }]
        })
    }

    fn slice(
        &mut self,
        points: &[Point2],
        closed: bool,
        start: f64,
        end: f64,
    ) -> Result<Vec<Point2>, EvaluationError> {
        if end - start <= 1e-7 {
            return Ok(Vec::new());
        }
        let mut route = points.to_vec();
        if closed {
            route.push(points[0]);
        }
        self.charge(route.len())?;
        let mut cumulative = vec![0.0];
        for pair in route.windows(2) {
            let delta = pair[1].subtract(pair[0]);
            cumulative.push(cumulative[cumulative.len() - 1] + delta.0[0].hypot(delta.0[1]));
        }
        let total = cumulative[cumulative.len() - 1];
        if total <= 1e-7 {
            return Ok(Vec::new());
        }
        let start_distance = start.clamp(0.0, 1.0) * total;
        let end_distance = end.clamp(0.0, 1.0) * total;
        let mut output = vec![Self::sample(&route, &cumulative, start_distance)];
        for index in 1..route.len() - 1 {
            if cumulative[index] > start_distance + 1e-7 && cumulative[index] < end_distance - 1e-7
            {
                output.push(route[index]);
            }
        }
        output.push(Self::sample(&route, &cumulative, end_distance));
        self.deduplicate(&output)
    }

    fn sample(route: &[Point2], cumulative: &[f64], distance: f64) -> Point2 {
        let last = cumulative.len() - 1;
        if distance <= 0.0 {
            return route[0];
        }
        if distance >= cumulative[last] {
            return route[last];
        }
        let index = cumulative
            .partition_point(|v| *v < distance)
            .max(1)
            .min(last);
        let span = cumulative[index] - cumulative[index - 1];
        let amount = if span <= 1e-7 {
            0.0
        } else {
            (distance - cumulative[index - 1]) / span
        };
        route[index - 1].lerp(route[index], amount)
    }
}
