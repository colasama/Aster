use std::collections::BTreeSet;

use super::PyramidLevels;
use aster_render_ir::Extent2d;

struct Program;

impl Program {
    fn levels(lanes: &[[f32; 16]], size: Extent2d, blur: bool, glow: bool) -> PyramidLevels {
        let operations = lanes
            .iter()
            .flatten()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>();
        PyramidLevels::for_program(size, &operations, blur, glow)
    }
}

#[test]
fn pyramid_bounds_cover_fractional_lods_and_independent_chains() {
    let size = Extent2d {
        width: 321,
        height: 181,
    };
    let mut blur = [0.0; 16];
    blur[0] = 101.0;
    for (radius, expected) in [
        (0.0, 2),
        (3.0, 2),
        (6.0, 3),
        (6.001, 4),
        (48.0, 6),
        (384.0, 8),
    ] {
        blur[1] = radius;
        assert_eq!(
            Program::levels(&[blur], size, true, false),
            PyramidLevels {
                blur: expected,
                glow: 0
            }
        );
    }
    blur[1] = 6.0;
    let mut glow = [0.0; 16];
    glow[0] = 102.0;
    glow[2] = 48.0;
    let levels = Program::levels(&[blur, glow], size, true, true);
    assert_eq!(levels, PyramidLevels { blur: 6, glow: 6 });
    assert_eq!(
        levels.union(PyramidLevels { blur: 8, glow: 2 }),
        PyramidLevels { blur: 8, glow: 6 }
    );
    assert_eq!(
        Program::levels(
            &[blur],
            Extent2d {
                width: 1,
                height: 1
            },
            true,
            false
        )
        .blur,
        1
    );
    assert!(crate::pyramid::Pyramid::bytes(size, 3) < crate::pyramid::Pyramid::bytes(size, 8));
    assert_eq!(crate::pyramid::Pyramid::bytes(size, 0), 0);
}

#[test]
fn pyramid_bounds_use_all_channels_and_conservative_dynamic_radii() {
    let size = Extent2d {
        width: 1920,
        height: 1080,
    };
    for (code, lane, value, expected) in [
        (116.0, 3, 48.0, 6),
        (104.0, 14, 1.0, 5),
        (105.0, 4, 1.0, 6),
        (123.0, 1, 48.0, 6),
        (219.0, 1, 24.0, 4),
        (248.0, 2, 12.0, 4),
    ] {
        let mut op = [0.0; 16];
        op[0] = code;
        op[lane] = value;
        assert_eq!(Program::levels(&[op], size, true, false).blur, expected);
    }
    let mut bokeh = [0.0; 16];
    bokeh[0] = 268.0;
    bokeh[1] = 12.0;
    bokeh[3] = -2.0;
    assert_eq!(Program::levels(&[bokeh], size, true, false).blur, 5);
    for invalid in [f32::INFINITY, f32::NAN] {
        bokeh[1] = invalid;
        assert_eq!(Program::levels(&[bokeh], size, true, false).blur, 8);
    }
    bokeh[1] = f32::MAX;
    assert_eq!(Program::levels(&[bokeh], size, true, false).blur, 8);
    bokeh[0] = 269.0;
    assert_eq!(Program::levels(&[bokeh], size, false, true).glow, 8);
    assert_eq!(
        PyramidLevels::for_program(size, &[0; 63], true, false).blur,
        8
    );
}

#[test]
fn shared_shader_pyramid_consumers_remain_in_the_radius_audit()
-> Result<(), Box<dyn std::error::Error>> {
    let catalog = aster_shaders::ShaderCatalog::embedded()?;
    let source = &catalog.program("post-process")?.source;
    let mut consumers = BTreeSet::new();
    for case in source.split("case ").skip(1) {
        let start = case.find('{').ok_or("case body absent")?;
        let mut depth = 0;
        let mut end = start;
        for (index, character) in case.char_indices().skip(start) {
            if character == '{' {
                depth += 1;
            }
            if character == '}' {
                depth -= 1;
            }
            if depth == 0 {
                end = index;
                break;
            }
        }
        let body = &case[start..end];
        if body.contains("sample_blur(")
            || body.contains("sample_masked_blur(")
            || body.contains("textureSampleLevel(blur_scene")
        {
            let code = case
                .split('u')
                .next()
                .ok_or("case opcode absent")?
                .parse::<u32>()?;
            consumers.insert(code);
        }
    }
    assert_eq!(
        consumers,
        BTreeSet::from([
            17, 101, 102, 104, 105, 116, 118, 121, 123, 141, 146, 171, 219, 221, 222, 223, 224,
            225, 226, 240, 248, 268
        ])
    );
    Ok(())
}
