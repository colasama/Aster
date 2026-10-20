use aster_eval::{SceneGeometry, SceneGeometryRecord};
use std::{collections::BTreeSet, error::Error};

struct Fixture;
impl Fixture {
    fn geometry(position: [f32; 2]) -> SceneGeometry {
        let mut data = vec![0.0; 80];
        data[0..2].copy_from_slice(&position);
        data[40..42].copy_from_slice(&position);
        SceneGeometry {
            data,
            batches: vec![SceneGeometryRecord {
                instance_id: "instance".into(),
                resource_instance_id: "resource".into(),
                selection_id: "selection".into(),
                first_vertex: 0,
                vertex_count: 2,
            }],
        }
    }
}

#[test]
fn endpoint_motion_requires_matching_topology_identity_and_valid_ranges()
-> Result<(), Box<dyn Error>> {
    let current = Fixture::geometry([17.0, -45.0]);
    let open = Fixture::geometry([0.0, 0.0]);
    let mut close = Fixture::geometry([32.0, -0.5]);
    assert_eq!(
        current.motion_vectors(&open, &close, None)?,
        [8.0, 0.25, 8.0, 0.25]
    );
    assert_eq!(
        current.motion_vectors(&close, &open, None)?,
        [-8.0, -0.25, -8.0, -0.25]
    );
    assert_eq!(
        current.motion_vectors(&open, &close, Some(&BTreeSet::new()))?,
        [0.0; 4]
    );
    close.batches[0].resource_instance_id = "other-resource".into();
    assert_eq!(current.motion_vectors(&open, &close, None)?, [0.0; 4]);
    close.batches[0].resource_instance_id = "resource".into();
    close.batches[0].vertex_count = 1;
    assert_eq!(current.motion_vectors(&open, &close, None)?, [0.0; 4]);
    close.batches[0].vertex_count = 3;
    assert!(current.motion_vectors(&open, &close, None).is_err());
    close.batches.clear();
    assert_eq!(current.motion_vectors(&open, &close, None)?, [0.0; 4]);
    close.data.pop();
    assert!(current.motion_vectors(&open, &close, None).is_err());
    Ok(())
}
