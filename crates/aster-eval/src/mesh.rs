use crate::{CameraProjector, EvaluatedTransform, EvaluationError, vector::Vector3};
use aster_types::editor::{Layer, Mesh};

use crate::vertex::{SceneVertex, VertexPaint};

#[derive(Clone, Debug, clap::Args)]
pub struct GeometryLimits {
    #[arg(long, default_value_t = Self::default().max_mesh_vertices)]
    pub max_mesh_vertices: usize,
    #[arg(long, default_value_t = Self::default().max_mesh_indices)]
    pub max_mesh_indices: usize,
}

impl Default for GeometryLimits {
    fn default() -> Self {
        Self {
            max_mesh_vertices: 1_000_000,
            max_mesh_indices: 3_000_000,
        }
    }
}

#[derive(Clone, Debug)]
pub struct MeshGeometry {
    vertices: Vec<MeshVertex>,
    indices: Vec<usize>,
    center: [f64; 3],
    extents: [f64; 3],
    imported: bool,
}

#[derive(Clone, Debug)]
struct MeshVertex {
    position: [f64; 3],
    normal: [f64; 3],
    uv: [f64; 2],
    tangent: [f64; 4],
}

impl MeshGeometry {
    pub fn vertex_count(&self) -> usize {
        self.indices.len()
    }
    pub fn compile(mesh: Option<&Mesh>, limits: &GeometryLimits) -> Result<Self, EvaluationError> {
        let Some(mesh) = mesh else {
            return Self::cube(limits);
        };
        let count = mesh.positions.len() / 3;
        if !mesh.positions.len().is_multiple_of(3)
            || count > limits.max_mesh_vertices
            || mesh.indices.len() > limits.max_mesh_indices
            || !mesh.indices.len().is_multiple_of(3)
            || mesh.normals.len() != mesh.positions.len()
            || mesh.uvs.len() != count * 2
            || mesh.tangents.value().is_some_and(|v| v.len() != count * 4)
        {
            return Err(EvaluationError::InvalidScene(
                "invalid mesh streams or geometry budget exceeded".into(),
            ));
        }
        let mut indices = Vec::with_capacity(mesh.indices.len());
        for value in &mesh.indices {
            let index = value
                .as_f64()
                .filter(|v| v.is_finite() && *v >= 0.0 && v.fract() == 0.0 && *v < count as f64)
                .map(|v| v as usize)
                .ok_or_else(|| {
                    EvaluationError::InvalidScene("mesh index outside position stream".into())
                })?;
            indices.push(index);
        }
        let mut minimum = [f64::INFINITY; 3];
        let mut maximum = [f64::NEG_INFINITY; 3];
        let mut vertices = Vec::with_capacity(count);
        for index in 0..count {
            let position = VertexPaint::numbers::<3>(&mesh.positions[index * 3..index * 3 + 3])?;
            for axis in 0..3 {
                minimum[axis] = minimum[axis].min(position[axis]);
                maximum[axis] = maximum[axis].max(position[axis]);
            }
            vertices.push(MeshVertex {
                position,
                normal: VertexPaint::numbers::<3>(&mesh.normals[index * 3..index * 3 + 3])?,
                uv: VertexPaint::numbers::<2>(&mesh.uvs[index * 2..index * 2 + 2])?,
                tangent: if let Some(tangents) = mesh.tangents.value() {
                    VertexPaint::numbers::<4>(&tangents[index * 4..index * 4 + 4])?
                } else {
                    [1.0, 0.0, 0.0, 1.0]
                },
            });
        }
        Ok(Self {
            vertices,
            indices,
            imported: true,
            center: std::array::from_fn(|i| {
                if count == 0 {
                    0.0
                } else {
                    (minimum[i] + maximum[i]) / 2.0
                }
            }),
            extents: std::array::from_fn(|i| {
                if count == 0 {
                    0.0
                } else {
                    maximum[i] - minimum[i]
                }
            }),
        })
    }

    /// Produces the shared 40-float vertex layout, preserving imported index order.
    pub fn evaluate(
        &self,
        layer: &Layer,
        transform: &EvaluatedTransform,
        size: [f64; 2],
        camera: &CameraProjector,
    ) -> Result<Vec<f32>, EvaluationError> {
        if layer.kind != "mesh" || size.iter().any(|v| !v.is_finite() || *v <= 0.0) {
            return Err(EvaluationError::InvalidScene(
                "invalid mesh draw context".into(),
            ));
        }
        let source_size = VertexPaint::numbers::<2>(&layer.size)?;
        let width = source_size[0] * transform.scale[0] / 100.0;
        let height = source_size[1] * transform.scale[1] / 100.0;
        let depth = width.min(height) * 0.68;
        let anchor = [
            (source_size[0] * 0.5 - transform.anchor[0]) * transform.scale[0] / 100.0,
            (source_size[1] * 0.5 - transform.anchor[1]) * transform.scale[1] / 100.0,
            -transform.anchor[2] * transform.scale[2] / 100.0,
        ];
        let scale = [width, height, depth]
            .into_iter()
            .enumerate()
            .filter_map(|(i, target)| (self.extents[i] > 1e-6).then_some(target / self.extents[i]))
            .filter(|v| v.is_finite())
            .reduce(f64::min)
            .unwrap_or(1.0);
        let paint = VertexPaint::evaluate(layer, transform.opacity, [width, height])?;
        let mut output = Vec::with_capacity(self.indices.len() * 40);
        for &index in &self.indices {
            let vertex = &self.vertices[index];
            let (local, normal, tangent, handedness) = if self.imported {
                let p: [f64; 3] =
                    std::array::from_fn(|i| (vertex.position[i] - self.center[i]) * scale);
                (
                    [p[0], -p[1], p[2]],
                    [vertex.normal[0], -vertex.normal[1], vertex.normal[2]],
                    [vertex.tangent[0], -vertex.tangent[1], vertex.tangent[2]],
                    -vertex.tangent[3],
                )
            } else {
                (
                    [
                        vertex.position[0] * width,
                        vertex.position[1] * height,
                        vertex.position[2] * depth,
                    ],
                    vertex.normal,
                    [vertex.tangent[0], vertex.tangent[1], vertex.tangent[2]],
                    vertex.tangent[3],
                )
            };
            let world = Vector3(local)
                .add(Vector3(anchor))
                .rotate_euler(transform.rotation)
                .add(Vector3(transform.position))
                .0;
            let normal = Vector3(normal).rotate_euler(transform.rotation).0;
            let tangent = Vector3(tangent).rotate_euler(transform.rotation).0;
            let projected = camera.project(world);
            let data = paint.vertex(
                SceneVertex {
                    clip: [
                        projected.screen[0],
                        projected.screen[1],
                        projected.normalized_depth,
                    ],
                    world,
                    uv: vertex.uv,
                    normal,
                    tangent: [tangent[0], tangent[1], tangent[2], handedness],
                    media_type: 0.0,
                },
                size,
            )?;
            output.extend_from_slice(&data);
        }
        Ok(output)
    }

    fn cube(limits: &GeometryLimits) -> Result<Self, EvaluationError> {
        if limits.max_mesh_vertices < 24 || limits.max_mesh_indices < 36 {
            return Err(EvaluationError::InvalidScene(
                "cube exceeds geometry budget".into(),
            ));
        }
        let faces = [
            (
                [0.0, 0.0, 1.0],
                [
                    [-0.5, -0.5, 0.5],
                    [0.5, -0.5, 0.5],
                    [-0.5, 0.5, 0.5],
                    [0.5, 0.5, 0.5],
                ],
            ),
            (
                [0.0, 0.0, -1.0],
                [
                    [0.5, -0.5, -0.5],
                    [-0.5, -0.5, -0.5],
                    [0.5, 0.5, -0.5],
                    [-0.5, 0.5, -0.5],
                ],
            ),
            (
                [1.0, 0.0, 0.0],
                [
                    [0.5, -0.5, 0.5],
                    [0.5, -0.5, -0.5],
                    [0.5, 0.5, 0.5],
                    [0.5, 0.5, -0.5],
                ],
            ),
            (
                [-1.0, 0.0, 0.0],
                [
                    [-0.5, -0.5, -0.5],
                    [-0.5, -0.5, 0.5],
                    [-0.5, 0.5, -0.5],
                    [-0.5, 0.5, 0.5],
                ],
            ),
            (
                [0.0, -1.0, 0.0],
                [
                    [-0.5, -0.5, -0.5],
                    [0.5, -0.5, -0.5],
                    [-0.5, -0.5, 0.5],
                    [0.5, -0.5, 0.5],
                ],
            ),
            (
                [0.0, 1.0, 0.0],
                [
                    [-0.5, 0.5, 0.5],
                    [0.5, 0.5, 0.5],
                    [-0.5, 0.5, -0.5],
                    [0.5, 0.5, -0.5],
                ],
            ),
        ];
        let mut result = Self {
            vertices: Vec::with_capacity(24),
            indices: Vec::with_capacity(36),
            center: [0.0; 3],
            extents: [1.0; 3],
            imported: false,
        };
        for (normal, corners) in faces {
            let offset = result.vertices.len();
            for (position, uv) in
                corners
                    .into_iter()
                    .zip([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]])
            {
                result.vertices.push(MeshVertex {
                    position,
                    normal,
                    uv,
                    tangent: [1.0, 0.0, 0.0, 1.0],
                });
            }
            result
                .indices
                .extend([0, 1, 2, 2, 1, 3].map(|i| offset + i));
        }
        Ok(result)
    }
}
