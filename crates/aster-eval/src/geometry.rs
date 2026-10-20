use crate::{
    CameraProjector, EvaluatedTransform, EvaluationError, EvaluationLimits, ExpressionLimits,
    GeometryLimits, MeshGeometry, PathLimits, PathTessellator, PathTrack, Point2,
    vector::Vector3,
    vertex::{SceneVertex, VertexPaint},
};
use aster_types::editor::Layer;

#[derive(Clone, Debug)]
pub enum LayerGeometry {
    Mesh(MeshGeometry),
    Bezier(PathTrack),
    Quad,
}

#[derive(Clone, Debug)]
pub struct GeometryContext {
    pub composition_size: [f64; 2],
    pub source_size: [f64; 2],
    pub origin: [f64; 2],
    pub local_time: f64,
}

impl LayerGeometry {
    pub fn compile(
        layer: &Layer,
        limits: &GeometryLimits,
        path_limits: &PathLimits,
        evaluation: &EvaluationLimits,
        expressions: &ExpressionLimits,
    ) -> Result<Option<Self>, EvaluationError> {
        if [
            "generator",
            "adjustment",
            "null",
            "audio",
            "camera",
            "light",
        ]
        .contains(&layer.kind.as_str())
        {
            return Ok(None);
        }
        if layer.kind == "mesh" {
            return Ok(Some(Self::Mesh(MeshGeometry::compile(
                layer.mesh.value(),
                limits,
            )?)));
        }
        if layer.kind == "shape"
            && let Some(shape) = layer
                .shape
                .value()
                .filter(|s| s.kind == "bezier" && s.path.value().is_some())
        {
            return Ok(Some(Self::Bezier(PathTrack::compile(
                shape,
                layer
                    .expressions
                    .value()
                    .and_then(|e| e.get("shape.morphProgress"))
                    .map(String::as_str),
                path_limits,
                evaluation,
                expressions,
            )?)));
        }
        Ok(Some(Self::Quad))
    }

    pub fn evaluate(
        &self,
        layer: &Layer,
        transform: &EvaluatedTransform,
        context: &GeometryContext,
        camera: &CameraProjector,
        limits: &PathLimits,
    ) -> Result<Vec<f32>, EvaluationError> {
        if let Self::Mesh(mesh) = self {
            return mesh.evaluate(layer, transform, context.composition_size, camera);
        }
        let size = [
            context.source_size[0] * transform.scale[0] / 100.0,
            context.source_size[1] * transform.scale[1] / 100.0,
        ];
        let anchor = [
            (context.origin[0] + context.source_size[0] * 0.5 - transform.anchor[0])
                * transform.scale[0]
                / 100.0,
            (context.origin[1] + context.source_size[1] * 0.5 - transform.anchor[1])
                * transform.scale[1]
                / 100.0,
            -transform.anchor[2] * transform.scale[2] / 100.0,
        ];
        let paint = VertexPaint::evaluate(layer, transform.opacity, size)?;
        let projection = GeometryProjection {
            size,
            anchor,
            transform: transform.clone(),
            composition_size: context.composition_size,
            three_dimensional: layer.three_dimensional,
            media_type: if layer.kind == "video" { 2.0 } else { 0.0 },
            normal: Vector3([0.0, 0.0, 1.0]).rotate_euler(transform.rotation).0,
            tangent: Vector3([1.0, 0.0, 0.0]).rotate_euler(transform.rotation).0,
        };
        let mut output = Vec::new();
        match self {
            Self::Mesh(_) => unreachable!("mesh returned before planar geometry"),
            Self::Quad => {
                output.reserve(6 * 40);
                for point in [
                    [-0.5, -0.5],
                    [0.5, -0.5],
                    [-0.5, 0.5],
                    [-0.5, 0.5],
                    [0.5, -0.5],
                    [0.5, 0.5],
                ] {
                    output.extend_from_slice(&projection.vertex(Point2(point), &paint, camera)?);
                }
            }
            Self::Bezier(track) => {
                let Some(path) = track.evaluate(context.local_time)? else {
                    return Ok(output);
                };
                let shape = layer.shape.value().ok_or_else(|| {
                    EvaluationError::InvalidScene("missing compiled shape".into())
                })?;
                let geometry = PathTessellator::new(limits).geometry(&path, shape, size)?;
                if geometry.fill.len().saturating_add(geometry.stroke.len())
                    > limits.max_triangle_vertices
                {
                    return Err(EvaluationError::InvalidScene(
                        "combined path geometry budget exceeded".into(),
                    ));
                }
                output.reserve((geometry.fill.len() + geometry.stroke.len()) * 40);
                let mut fill = paint.clone();
                fill.shape_color = [1.0; 4];
                for point in geometry.fill {
                    output.extend_from_slice(&projection.vertex(point, &fill, camera)?);
                }
                let mut stroke = fill;
                stroke.color = VertexPaint::numbers::<4>(&shape.stroke_color)?;
                stroke.color[3] *= transform.opacity;
                stroke.gradient_color = [1.0; 4];
                stroke.gradient_parameters = [0.0; 4];
                for point in geometry.stroke {
                    output.extend_from_slice(&projection.vertex(point, &stroke, camera)?);
                }
            }
        }
        Ok(output)
    }
}

struct GeometryProjection {
    size: [f64; 2],
    anchor: [f64; 3],
    transform: EvaluatedTransform,
    composition_size: [f64; 2],
    three_dimensional: bool,
    media_type: f64,
    normal: [f64; 3],
    tangent: [f64; 3],
}

impl GeometryProjection {
    fn vertex(
        &self,
        point: Point2,
        paint: &VertexPaint,
        camera: &CameraProjector,
    ) -> Result<[f32; 40], EvaluationError> {
        let local = [
            point.0[0] * self.size[0] + self.anchor[0],
            point.0[1] * self.size[1] + self.anchor[1],
            self.anchor[2],
        ];
        let position = self.transform.position;
        let (world, clip) = if self.three_dimensional {
            let world = Vector3(local)
                .rotate_euler(self.transform.rotation)
                .add(Vector3(position))
                .0;
            let projected = camera.project(world);
            (
                world,
                [
                    projected.screen[0],
                    projected.screen[1],
                    projected.normalized_depth,
                ],
            )
        } else {
            let angle = self.transform.rotation[2] * std::f64::consts::PI / 180.0;
            let world = [
                position[0] + local[0] * angle.cos() - local[1] * angle.sin(),
                position[1] + local[0] * angle.sin() + local[1] * angle.cos(),
                position[2] + local[2],
            ];
            (world, [world[0], world[1], 1.0])
        };
        paint.vertex(
            SceneVertex {
                clip,
                world,
                uv: [point.0[0] + 0.5, point.0[1] + 0.5],
                normal: self.normal,
                tangent: [self.tangent[0], self.tangent[1], self.tangent[2], 1.0],
                media_type: self.media_type,
            },
            self.composition_size,
        )
    }
}
