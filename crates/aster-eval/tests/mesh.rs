use aster_eval::{GeometryLimits, MeshGeometry};
use aster_types::editor::{Field, Mesh};
use std::{collections::BTreeMap, error::Error};

#[test]
fn malformed_meshes_and_geometry_budget_fail_before_vertex_access() -> Result<(), Box<dyn Error>> {
    let mut mesh = Mesh {
        name: "triangle".into(),
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0].map(Into::into).to_vec(),
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1].map(Into::into).to_vec(),
        uvs: [0, 0, 1, 0, 0, 1].map(Into::into).to_vec(),
        indices: [0, 1, 2].map(Into::into).to_vec(),
        tangents: Field::Absent,
        source_material: Field::Absent,
        base_color: Field::Absent,
        material_textures: Field::Absent,
        extensions: BTreeMap::new(),
    };
    let limits = GeometryLimits::default();
    mesh.indices[1] = serde_json::from_str("1.0")?;
    assert_eq!(
        MeshGeometry::compile(Some(&mesh), &limits)?.vertex_count(),
        3
    );
    assert!(
        MeshGeometry::compile(
            Some(&mesh),
            &GeometryLimits {
                max_mesh_indices: 2,
                ..limits.clone()
            }
        )
        .is_err()
    );
    assert!(
        MeshGeometry::compile(
            None,
            &GeometryLimits {
                max_mesh_vertices: 23,
                ..limits.clone()
            }
        )
        .is_err()
    );
    mesh.indices[2] = 3.into();
    assert!(MeshGeometry::compile(Some(&mesh), &limits).is_err());
    mesh.indices[2] = 2.into();
    mesh.normals.pop();
    assert!(MeshGeometry::compile(Some(&mesh), &limits).is_err());
    mesh.normals.push(1.into());
    mesh.tangents = Field::Value(vec![1.into()]);
    assert!(MeshGeometry::compile(Some(&mesh), &limits).is_err());
    Ok(())
}
