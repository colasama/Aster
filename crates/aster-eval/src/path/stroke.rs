use super::{PathTessellator, Point2};
use crate::EvaluationError;

struct Join {
    center: Point2,
    previous_direction: Point2,
    next_direction: Point2,
    previous_normal: Point2,
    next_normal: Point2,
    half: f64,
}

impl PathTessellator {
    pub fn stroke(
        &mut self,
        source: &[Point2],
        width: f64,
        closed: bool,
        join: &str,
        cap: &str,
    ) -> Result<Vec<Point2>, EvaluationError> {
        if !width.is_finite() {
            return Err(EvaluationError::InvalidScene("invalid stroke width".into()));
        }
        let points = self.deduplicate(source)?;
        if points.len() < 2 || width <= 0.0 {
            return Ok(Vec::new());
        }
        let half = width / 2.0;
        let count = if closed {
            points.len()
        } else {
            points.len() - 1
        };
        let mut directions = Vec::with_capacity(count);
        let mut normals = Vec::with_capacity(count);
        let mut triangles = Vec::new();
        for index in 0..count {
            let start = points[index];
            let end = points[(index + 1) % points.len()];
            let direction = end.subtract(start).normalize();
            let normal = Point2([-direction.0[1] * half, direction.0[0] * half]);
            directions.push(direction);
            normals.push(normal);
            let a = start.add(normal);
            let b = start.subtract(normal);
            let c = end.add(normal);
            let d = end.subtract(normal);
            self.append(
                &mut triangles,
                &[a, b, c, c, b, d],
                self.limits.max_triangle_vertices,
            )?;
        }
        let start = if closed { 0 } else { 1 };
        let end = if closed {
            points.len()
        } else {
            points.len() - 1
        };
        for index in start..end {
            let previous = (index + count - 1) % count;
            let next = index % count;
            self.join(
                &mut triangles,
                Join {
                    center: points[index % points.len()],
                    previous_direction: directions[previous],
                    next_direction: directions[next],
                    previous_normal: normals[previous],
                    next_normal: normals[next],
                    half,
                },
                join,
            )?;
        }
        if !closed && cap == "round" {
            self.round_cap(&mut triangles, points[0], directions[0], half, true)?;
            self.round_cap(
                &mut triangles,
                points[points.len() - 1],
                directions[count - 1],
                half,
                false,
            )?;
        }
        Ok(triangles)
    }

    fn join(
        &mut self,
        output: &mut Vec<Point2>,
        input: Join,
        kind: &str,
    ) -> Result<(), EvaluationError> {
        let Join {
            center,
            previous_direction,
            next_direction,
            previous_normal,
            next_normal,
            half,
        } = input;
        let turn = previous_direction.0[0] * next_direction.0[1]
            - previous_direction.0[1] * next_direction.0[0];
        if turn.abs() <= 1e-7 {
            return Ok(());
        }
        let side = if turn > 0.0 { -1.0 } else { 1.0 };
        let previous_outer = center.add(previous_normal.scale(side));
        let next_outer = center.add(next_normal.scale(side));
        if kind == "bevel" {
            return self.append(
                output,
                &[center, previous_outer, next_outer],
                self.limits.max_triangle_vertices,
            );
        }
        if kind == "miter" {
            let miter = previous_normal.add(next_normal).scale(side).normalize();
            let next_unit = next_normal.scale(side / half);
            let denominator = (miter.0[0] * next_unit.0[0] + miter.0[1] * next_unit.0[1]).max(0.25);
            let point = center.add(miter.scale((half * 4.0).min(half / denominator)));
            return self.append(
                output,
                &[
                    center,
                    previous_outer,
                    next_outer,
                    previous_outer,
                    point,
                    next_outer,
                ],
                self.limits.max_triangle_vertices,
            );
        }
        let start_angle =
            (previous_outer.0[1] - center.0[1]).atan2(previous_outer.0[0] - center.0[0]);
        let mut end_angle = (next_outer.0[1] - center.0[1]).atan2(next_outer.0[0] - center.0[0]);
        if turn > 0.0 && end_angle < start_angle {
            end_angle += std::f64::consts::PI * 2.0;
        }
        if turn < 0.0 && end_angle > start_angle {
            end_angle -= std::f64::consts::PI * 2.0;
        }
        let steps = ((end_angle - start_angle).abs() / (std::f64::consts::PI / 8.0))
            .ceil()
            .max(1.0) as usize;
        let mut previous = previous_outer;
        for step in 1..=steps {
            let angle = start_angle + ((end_angle - start_angle) * step as f64) / steps as f64;
            let next = Point2([
                center.0[0] + angle.cos() * half,
                center.0[1] + angle.sin() * half,
            ]);
            self.append(
                output,
                &[center, previous, next],
                self.limits.max_triangle_vertices,
            )?;
            previous = next;
        }
        Ok(())
    }

    fn round_cap(
        &mut self,
        output: &mut Vec<Point2>,
        center: Point2,
        direction: Point2,
        radius: f64,
        start: bool,
    ) -> Result<(), EvaluationError> {
        let outward = if start {
            (-direction.0[1]).atan2(-direction.0[0])
        } else {
            direction.0[1].atan2(direction.0[0])
        };
        let initial = outward - std::f64::consts::PI / 2.0;
        let mut previous = Point2([
            center.0[0] + initial.cos() * radius,
            center.0[1] + initial.sin() * radius,
        ]);
        for step in 1..=8 {
            let angle = outward - std::f64::consts::PI / 2.0
                + (std::f64::consts::PI * f64::from(step)) / 8.0;
            let next = Point2([
                center.0[0] + angle.cos() * radius,
                center.0[1] + angle.sin() * radius,
            ]);
            self.append(
                output,
                &[center, previous, next],
                self.limits.max_triangle_vertices,
            )?;
            previous = next;
        }
        Ok(())
    }
}
