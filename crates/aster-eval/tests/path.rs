use aster_eval::{EvaluatedPath, PathLimits, PathTessellator, PathVertex, Point2};

#[test]
fn path_work_and_output_limits_fail_without_truncating_successful_geometry() {
    let path = EvaluatedPath {
        closed: false,
        vertices: vec![
            PathVertex {
                position: Point2([-0.5, 0.25]),
                in_tangent: Point2([0.0, 0.0]),
                out_tangent: Point2([0.3, -0.5]),
            },
            PathVertex {
                position: Point2([0.5, -0.25]),
                in_tangent: Point2([-0.3, 0.5]),
                out_tangent: Point2([0.0, 0.0]),
            },
        ],
    };
    let small = PathLimits {
        max_flattened_points: 2,
        ..PathLimits::default()
    };
    assert!(PathTessellator::new(&small).flatten(&path, 0.002).is_err());
    let exhausted = PathLimits {
        max_path_operations: 0,
        ..PathLimits::default()
    };
    assert!(
        PathTessellator::new(&exhausted)
            .flatten(&path, 0.002)
            .is_err()
    );
    let triangle_limit = PathLimits {
        max_triangle_vertices: 5,
        ..PathLimits::default()
    };
    assert!(
        PathTessellator::new(&triangle_limit)
            .stroke(
                &[Point2([0.0, 0.0]), Point2([10.0, 0.0])],
                1.0,
                false,
                "round",
                "round"
            )
            .is_err()
    );
    assert!(
        PathTessellator::new(&PathLimits::default())
            .triangulate(&[Point2([f64::NAN, 0.0])])
            .is_err()
    );
}
