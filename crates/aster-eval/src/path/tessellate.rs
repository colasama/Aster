use super::{EvaluatedPath, PathTessellator, Point2};
use crate::EvaluationError;

impl PathTessellator {
    pub fn flatten(
        &mut self,
        path: &EvaluatedPath,
        tolerance: f64,
    ) -> Result<Vec<Point2>, EvaluationError> {
        if path.vertices.len() > self.limits.max_path_vertices
            || !tolerance.is_finite()
            || tolerance < 0.0
        {
            return Err(EvaluationError::InvalidScene(
                "invalid path flattening input".into(),
            ));
        }
        let mut points = Vec::new();
        if path.vertices.len() < 2 {
            for vertex in &path.vertices {
                self.append(
                    &mut points,
                    &[vertex.position],
                    self.limits.max_flattened_points,
                )?;
            }
            return Ok(points);
        }
        self.append(
            &mut points,
            &[path.vertices[0].position],
            self.limits.max_flattened_points,
        )?;
        let count = if path.closed {
            path.vertices.len()
        } else {
            path.vertices.len() - 1
        };
        for index in 0..count {
            let start = &path.vertices[index];
            let end = &path.vertices[(index + 1) % path.vertices.len()];
            let mut stack = vec![(
                [
                    start.position,
                    start.position.add(start.out_tangent),
                    end.position.add(end.in_tangent),
                    end.position,
                ],
                0,
            )];
            while let Some(([p0, p1, p2, p3], depth)) = stack.pop() {
                self.charge(1)?;
                if depth >= 12
                    || p1
                        .line_distance_squared(p0, p3)
                        .max(p2.line_distance_squared(p0, p3))
                        <= tolerance * tolerance
                {
                    self.append(&mut points, &[p3], self.limits.max_flattened_points)?;
                } else {
                    let p01 = p0.midpoint(p1);
                    let p12 = p1.midpoint(p2);
                    let p23 = p2.midpoint(p3);
                    let p012 = p01.midpoint(p12);
                    let p123 = p12.midpoint(p23);
                    let center = p012.midpoint(p123);
                    stack.push(([center, p123, p23, p3], depth + 1));
                    stack.push(([p0, p01, p012, center], depth + 1));
                }
            }
        }
        if path.closed
            && points
                .last()
                .is_some_and(|last| points[0].distance_squared(*last) <= 1e-7)
        {
            points.pop();
        }
        self.deduplicate(&points)
    }

    pub fn triangulate(&mut self, source: &[Point2]) -> Result<Vec<Point2>, EvaluationError> {
        let points = self.deduplicate(source)?;
        if points.len() < 3 {
            return Ok(Vec::new());
        }
        let area = points.iter().enumerate().fold(0.0, |area, (i, p)| {
            let next = points[(i + 1) % points.len()];
            area + p.0[0] * next.0[1] - next.0[0] * p.0[1]
        });
        let orientation = if area >= 0.0 { 1.0 } else { -1.0 };
        let mut indices: Vec<_> = (0..points.len()).collect();
        let mut triangles = Vec::new();
        let mut guard = points.len().saturating_mul(points.len());
        while indices.len() > 3 && guard > 0 {
            guard -= 1;
            let mut clipped = false;
            for cursor in 0..indices.len() {
                self.charge(indices.len())?;
                let previous = indices[(cursor + indices.len() - 1) % indices.len()];
                let current = indices[cursor];
                let next = indices[(cursor + 1) % indices.len()];
                if points[previous].cross(points[current], points[next]) * orientation <= 1e-7 {
                    continue;
                }
                if indices.iter().any(|&candidate| {
                    candidate != previous
                        && candidate != current
                        && candidate != next
                        && points[candidate].inside_triangle(
                            points[previous],
                            points[current],
                            points[next],
                        )
                }) {
                    continue;
                }
                self.append(
                    &mut triangles,
                    &[points[previous], points[current], points[next]],
                    self.limits.max_triangle_vertices,
                )?;
                indices.remove(cursor);
                clipped = true;
                break;
            }
            if !clipped {
                break;
            }
        }
        if indices.len() == 3 {
            self.append(
                &mut triangles,
                &[points[indices[0]], points[indices[1]], points[indices[2]]],
                self.limits.max_triangle_vertices,
            )?;
        }
        Ok(triangles)
    }
}
