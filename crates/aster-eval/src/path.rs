mod math;
mod stroke;
mod tessellate;
mod trim;

use crate::{EvaluationError, EvaluationLimits, ExpressionLimits, PropertyTrack};
use aster_types::editor::{BezierPath, Shape};
pub use math::Point2;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, clap::Args)]
pub struct PathLimits {
    #[arg(long, default_value_t = Self::default().max_path_vertices)]
    pub max_path_vertices: usize,
    #[arg(long, default_value_t = Self::default().max_flattened_points)]
    pub max_flattened_points: usize,
    #[arg(long, default_value_t = Self::default().max_triangle_vertices)]
    pub max_triangle_vertices: usize,
    #[arg(long, default_value_t = Self::default().max_path_operations)]
    pub max_path_operations: usize,
}

impl Default for PathLimits {
    fn default() -> Self {
        Self {
            max_path_vertices: 512,
            max_flattened_points: 65_536,
            max_triangle_vertices: 1_000_000,
            max_path_operations: 16_000_000,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathVertex {
    pub position: Point2,
    pub in_tangent: Point2,
    pub out_tangent: Point2,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EvaluatedPath {
    pub closed: bool,
    pub vertices: Vec<PathVertex>,
}

#[derive(Clone, Debug)]
pub struct PathTrack {
    source: Option<EvaluatedPath>,
    target: Option<EvaluatedPath>,
    progress: Option<PropertyTrack>,
}

impl EvaluatedPath {
    pub fn compile(path: &BezierPath, limits: &PathLimits) -> Result<Self, EvaluationError> {
        if path.vertices.len() > limits.max_path_vertices {
            return Err(EvaluationError::InvalidScene(
                "path vertex budget exceeded".into(),
            ));
        }
        let mut vertices = Vec::with_capacity(path.vertices.len());
        for vertex in &path.vertices {
            vertices.push(PathVertex {
                position: Point2::compile(&vertex.position)?,
                in_tangent: Point2::compile(&vertex.in_tangent)?,
                out_tangent: Point2::compile(&vertex.out_tangent)?,
            });
        }
        Ok(Self {
            closed: path.closed,
            vertices,
        })
    }
}

impl PathTrack {
    pub fn compile(
        shape: &Shape,
        expression: Option<&str>,
        limits: &PathLimits,
        evaluation: &EvaluationLimits,
        expressions: &ExpressionLimits,
    ) -> Result<Self, EvaluationError> {
        let source = shape
            .path
            .value()
            .map(|path| EvaluatedPath::compile(path, limits))
            .transpose()?;
        let target = shape
            .morph
            .value()
            .map(|m| EvaluatedPath::compile(&m.target, limits))
            .transpose()?;
        if let (Some(source), Some(target)) = (&source, &target)
            && (source.closed != target.closed || source.vertices.len() != target.vertices.len())
        {
            return Err(EvaluationError::InvalidScene(
                "path morph topology mismatch".into(),
            ));
        }
        let progress = shape
            .morph
            .value()
            .map(|m| PropertyTrack::compile(&m.progress, expression, evaluation, expressions))
            .transpose()?;
        Ok(Self {
            source,
            target,
            progress,
        })
    }

    pub fn evaluate(&self, time: f64) -> Result<Option<EvaluatedPath>, EvaluationError> {
        if !time.is_finite() {
            return Err(EvaluationError::InvalidTime);
        }
        let Some(source) = &self.source else {
            return Ok(None);
        };
        let (Some(target), Some(progress)) = (&self.target, &self.progress) else {
            return Ok(Some(source.clone()));
        };
        let amount = (progress.evaluate(time)? / 100.0).clamp(0.0, 1.0);
        if amount == 0.0 {
            return Ok(Some(source.clone()));
        }
        if amount == 1.0 {
            return Ok(Some(target.clone()));
        }
        let vertices = source
            .vertices
            .iter()
            .zip(&target.vertices)
            .map(|(a, b)| PathVertex {
                position: a.position.lerp(b.position, amount),
                in_tangent: a.in_tangent.lerp(b.in_tangent, amount),
                out_tangent: a.out_tangent.lerp(b.out_tangent, amount),
            })
            .collect();
        Ok(Some(EvaluatedPath {
            closed: source.closed,
            vertices,
        }))
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct TrimmedPolyline {
    pub points: Vec<Point2>,
    pub closed: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct PathGeometry {
    pub fill: Vec<Point2>,
    pub stroke: Vec<Point2>,
}

pub struct PathTessellator {
    limits: PathLimits,
    remaining: usize,
}

impl PathTessellator {
    pub fn new(limits: &PathLimits) -> Self {
        Self {
            limits: limits.clone(),
            remaining: limits.max_path_operations,
        }
    }

    fn charge(&mut self, amount: usize) -> Result<(), EvaluationError> {
        self.remaining = self.remaining.checked_sub(amount).ok_or_else(|| {
            EvaluationError::InvalidScene("path operation budget exceeded".into())
        })?;
        Ok(())
    }

    fn append(
        &mut self,
        output: &mut Vec<Point2>,
        points: &[Point2],
        maximum: usize,
    ) -> Result<(), EvaluationError> {
        self.charge(points.len())?;
        if output
            .len()
            .checked_add(points.len())
            .is_none_or(|n| n > maximum)
            || points.iter().any(|p| !p.finite())
        {
            return Err(EvaluationError::InvalidScene(
                "invalid path output or output budget exceeded".into(),
            ));
        }
        output.extend_from_slice(points);
        Ok(())
    }

    fn deduplicate(&mut self, points: &[Point2]) -> Result<Vec<Point2>, EvaluationError> {
        if points.len() > self.limits.max_flattened_points || points.iter().any(|p| !p.finite()) {
            return Err(EvaluationError::InvalidScene(
                "invalid polyline or point budget exceeded".into(),
            ));
        }
        self.charge(points.len())?;
        Ok(points
            .iter()
            .enumerate()
            .filter(|(i, p)| *i == 0 || p.distance_squared(points[*i - 1]) > 1e-7)
            .map(|(_, p)| *p)
            .collect())
    }

    pub fn geometry(
        &mut self,
        path: &EvaluatedPath,
        shape: &Shape,
        size: [f64; 2],
    ) -> Result<PathGeometry, EvaluationError> {
        if size.iter().any(|v| !v.is_finite()) {
            return Err(EvaluationError::InvalidScene(
                "invalid path dimensions".into(),
            ));
        }
        let normalized = self.flatten(path, 0.002)?;
        let fill = if path.closed {
            self.triangulate(&normalized)?
        } else {
            Vec::new()
        };
        let mut stroke = Vec::new();
        let width = shape
            .stroke_width
            .as_f64()
            .ok_or_else(|| EvaluationError::InvalidScene("invalid stroke width".into()))?;
        if width > 0.0 {
            let scaled: Vec<_> = normalized
                .iter()
                .map(|p| Point2([p.0[0] * size[0], p.0[1] * size[1]]))
                .collect();
            let trim = shape.trim.value();
            let start = trim.and_then(|t| t.start.as_f64()).unwrap_or(0.0) / 100.0;
            let end = trim.and_then(|t| t.end.as_f64()).unwrap_or(100.0) / 100.0;
            let offset = trim.and_then(|t| t.offset.as_f64()).unwrap_or(0.0) / 100.0;
            for segment in self.trim(&scaled, path.closed, start, end, offset)? {
                let triangles = self.stroke(
                    &segment.points,
                    width,
                    segment.closed,
                    shape.line_join.value().map_or("round", String::as_str),
                    &shape.line_cap,
                )?;
                let divisor = size.map(|v| if v == 0.0 { 1.0 } else { v });
                let mapped: Vec<_> = triangles
                    .into_iter()
                    .map(|p| Point2([p.0[0] / divisor[0], p.0[1] / divisor[1]]))
                    .collect();
                self.append(&mut stroke, &mapped, self.limits.max_triangle_vertices)?;
            }
        }
        Ok(PathGeometry { fill, stroke })
    }
}
