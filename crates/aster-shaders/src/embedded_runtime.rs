use std::collections::BTreeMap;

use crate::ShaderCatalog;

impl ShaderCatalog {
    pub(crate) fn embedded_runtime_sources() -> BTreeMap<String, String> {
        [
            (
                "color/output-nv12.wgsl",
                include_str!("../../../shaders/color/output-nv12.wgsl"),
            ),
            (
                "audio/analysis-abi.wgsl",
                include_str!("../../../shaders/audio/analysis-abi.wgsl"),
            ),
            (
                "scene/generator-abi.wgsl",
                include_str!("../../../shaders/scene/generator-abi.wgsl"),
            ),
            (
                "scene/generator-line-break.wgsl",
                include_str!("../../../shaders/scene/generator-line-break.wgsl"),
            ),
            (
                "scene/particle-projection.wgsl",
                include_str!("../../../shaders/scene/particle-projection.wgsl"),
            ),
            (
                "scene/particle-compute-layout.wgsl",
                include_str!("../../../shaders/scene/particle-compute-layout.wgsl"),
            ),
            (
                "scene/particle-compute-functions.wgsl",
                include_str!("../../../shaders/scene/particle-compute-functions.wgsl"),
            ),
            (
                "scene/particle-render-layout.wgsl",
                include_str!("../../../shaders/scene/particle-render-layout.wgsl"),
            ),
            (
                "scene/particle-render-functions.wgsl",
                include_str!("../../../shaders/scene/particle-render-functions.wgsl"),
            ),
            (
                "text/motion-blur-raster.wgsl",
                include_str!("../../../shaders/text/motion-blur-raster.wgsl"),
            ),
            (
                "diagnostics/fullscreen-vertex.wgsl",
                include_str!("../../../shaders/diagnostics/fullscreen-vertex.wgsl"),
            ),
            (
                "diagnostics/scene-fragment.wgsl",
                include_str!("../../../shaders/diagnostics/scene-fragment.wgsl"),
            ),
            (
                "diagnostics/float-fragment.wgsl",
                include_str!("../../../shaders/diagnostics/float-fragment.wgsl"),
            ),
            (
                "diagnostics/uint-fragment.wgsl",
                include_str!("../../../shaders/diagnostics/uint-fragment.wgsl"),
            ),
        ]
        .into_iter()
        .map(|(path, source)| (path.to_owned(), source.to_owned()))
        .collect()
    }
}
