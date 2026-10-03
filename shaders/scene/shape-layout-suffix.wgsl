>,
}

@group(0) @binding(0) var<uniform> lighting: SceneLighting;
@group(0) @binding(1) var shadow_map: texture_depth_2d;
@group(0) @binding(2) var shadow_sampler: sampler_comparison;
