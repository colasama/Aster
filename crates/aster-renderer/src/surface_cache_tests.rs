use super::{NativeOptions, NativeRenderer};
use crate::{
    scene_input::SceneInput,
    surface_plan::{SurfaceInput, SurfacePlan},
};
use aster_render_ir::{Extent2d, IrFixture, RootSceneCommandsSlice};
use std::{collections::BTreeMap, time::Duration};

struct SurfaceFixture;
impl SurfaceFixture {
    fn input(
        key: u16,
        width: u32,
        height: u32,
    ) -> Result<SurfaceInput, Box<dyn std::error::Error>> {
        let size = Extent2d { width, height };
        let mut header = IrFixture::parts()?.0.header;
        header.target = size;
        header.render_target = size;
        Ok(SurfaceInput {
            key: vec![key],
            size,
            scene: SceneInput {
                header,
                lighting: vec![],
                vertices: vec![],
                clears: vec![],
                root: RootSceneCommandsSlice {
                    blob_index: 0,
                    draws: vec![],
                    commands: vec![],
                },
                layers: BTreeMap::new(),
                images: BTreeMap::new(),
            },
        })
    }
}

#[test]
#[ignore = "requires GPU"]
fn native_surface_cache_admits_atomically_reuses_and_retires_targets()
-> Result<(), Box<dyn std::error::Error>> {
    let mut renderer = NativeRenderer::new(NativeOptions {
        dxcompiler: None,
        adapter_name: None,
        gpu_budget_bytes: 1_048_576,
        timeout: Duration::from_secs(30),
        backend: if cfg!(target_os = "windows") {
            aster_render::NativeBackend::Dx12
        } else if cfg!(target_os = "macos") {
            aster_render::NativeBackend::Metal
        } else {
            aster_render::NativeBackend::Vulkan
        },
    })?;
    let device = &renderer.device;
    let layout = &renderer.images.layout;
    let cache = &mut renderer.surfaces;
    let timeout = renderer.options.timeout;
    let mut plan = SurfacePlan {
        targets: vec![
            SurfaceFixture::input(1, 2, 2)?,
            SurfaceFixture::input(2, 2, 2)?,
        ],
        bindings: BTreeMap::new(),
    };
    assert!(cache.prepare(device, layout, &plan, 95, timeout).is_err());
    assert_eq!(cache.statistics, Default::default());
    cache.prepare(device, layout, &plan, 96, timeout)?;
    assert_eq!(cache.statistics.allocations, 2);
    assert_eq!(cache.statistics.resident_bytes, 96);
    cache.prepare(device, layout, &plan, 96, timeout)?;
    assert_eq!(cache.statistics.hits, 2);
    assert_eq!(cache.statistics.allocations, 2);
    plan.targets[0].key = vec![3];
    plan.targets[1].key = vec![4];
    cache.prepare(device, layout, &plan, 96, timeout)?;
    assert_eq!(cache.statistics.reuses, 2);
    assert_eq!(cache.statistics.allocations, 2);
    assert!(cache.target(&[1]).is_err());
    assert!(cache.target(&[3]).is_ok());
    let before = cache.statistics;
    plan.targets.push(SurfaceFixture::input(5, 2, 2)?);
    assert!(cache.prepare(device, layout, &plan, 96, timeout).is_err());
    assert_eq!(cache.statistics, before);
    assert!(cache.target(&[4]).is_ok());
    plan.targets.truncate(1);
    cache.prepare(device, layout, &plan, 48, timeout)?;
    assert_eq!(cache.statistics.evictions, 1);
    assert_eq!(cache.statistics.resident_bytes, 48);
    plan.targets[0] = SurfaceFixture::input(3, 4, 4)?;
    cache.prepare(device, layout, &plan, 192, timeout)?;
    assert_eq!(cache.statistics.allocations, 3);
    assert_eq!(cache.statistics.evictions, 2);
    let before = cache.statistics;
    plan.targets[0] = SurfaceFixture::input(3, device.limits().max_texture_dimension_2d + 1, 1)?;
    assert!(
        cache
            .prepare(device, layout, &plan, u64::MAX, timeout)
            .is_err()
    );
    assert_eq!(cache.statistics, before);
    cache.prepare(device, layout, &SurfacePlan::default(), 0, timeout)?;
    assert_eq!(cache.statistics.resident_bytes, 0);
    assert!(cache.target(&[3]).is_err());
    Ok(())
}
