import { MAX_SCENE_LIGHTS } from "./scene-lighting";

export const shapeShader = createShapeShader(false);
export const materialShapeShader = createShapeShader(true);

function createShapeShader(materialTextures: boolean): string {
  const materialBindings = materialTextures
    ? /* wgsl */ `
struct MaterialTextureSettings {
  normal_environment: vec4f,
}

@group(1) @binding(0) var normal_texture: texture_2d<f32>;
@group(1) @binding(1) var environment_texture: texture_2d<f32>;
@group(1) @binding(2) var normal_sampler: sampler;
@group(1) @binding(3) var environment_sampler: sampler;
@group(1) @binding(4) var<uniform> material_textures: MaterialTextureSettings;

fn environment_uv(direction: vec3f, rotation: f32) -> vec2f {
  let normalized = safe_normalize3(direction, vec3f(0.0, 0.0, 1.0));
  let longitude = atan2(normalized.z, normalized.x) / 6.28318530718 + 0.5 + rotation;
  let latitude = acos(clamp(normalized.y, -1.0, 1.0)) / 3.14159265359;
  return vec2f(fract(longitude), clamp(latitude, 0.0, 1.0));
}

fn sample_environment_cone(direction: vec3f, spread: f32, rotation: f32) -> vec3f {
  let center = safe_normalize3(direction, vec3f(0.0, 0.0, 1.0));
  let reference = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(center.y) > 0.9);
  let tangent = safe_normalize3(cross(reference, center), vec3f(1.0, 0.0, 0.0));
  let bitangent = safe_normalize3(cross(center, tangent), vec3f(0.0, 1.0, 0.0));
  let radius = clamp(spread, 0.0, 1.0) * 0.62;
  var integrated = textureSampleLevel(
    environment_texture, environment_sampler, environment_uv(center, rotation), 0.0
  ).rgb * 0.4;
  integrated += textureSampleLevel(
    environment_texture, environment_sampler,
    environment_uv(safe_normalize3(center + tangent * radius, center), rotation), 0.0
  ).rgb * 0.15;
  integrated += textureSampleLevel(
    environment_texture, environment_sampler,
    environment_uv(safe_normalize3(center - tangent * radius, center), rotation), 0.0
  ).rgb * 0.15;
  integrated += textureSampleLevel(
    environment_texture, environment_sampler,
    environment_uv(safe_normalize3(center + bitangent * radius, center), rotation), 0.0
  ).rgb * 0.15;
  integrated += textureSampleLevel(
    environment_texture, environment_sampler,
    environment_uv(safe_normalize3(center - bitangent * radius, center), rotation), 0.0
  ).rgb * 0.15;
  return integrated;
}
`
    : "";
  const surfaceNormal = materialTextures
    ? /* wgsl */ `
    var normal = safe_normalize3(input.normal, vec3f(0.0, 0.0, 1.0));
    if material_textures.normal_environment.z > 0.5 {
      let sampled_normal = textureSampleLevel(normal_texture, normal_sampler, input.uv, 0.0).xyz * 2.0 - 1.0;
      let scaled_sample = vec3f(
        sampled_normal.xy * material_textures.normal_environment.x,
        sampled_normal.z,
      );
      let tangent_space_normal = safe_normalize3(scaled_sample, vec3f(0.0, 0.0, 1.0));
      let projected_tangent = input.tangent.xyz - normal * dot(input.tangent.xyz, normal);
      var tangent = vec3f(1.0, 0.0, 0.0);
      if dot(projected_tangent, projected_tangent) > 0.00000001 {
        tangent = safe_normalize3(projected_tangent, tangent);
      } else {
        let fallback_axis = select(
          vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(normal.y) > 0.9
        );
        tangent = safe_normalize3(cross(fallback_axis, normal), tangent);
      }
      let handedness = select(-1.0, 1.0, input.tangent.w >= 0.0);
      let bitangent = safe_normalize3(cross(normal, tangent), vec3f(0.0, 1.0, 0.0)) * handedness;
      normal = safe_normalize3(
        tangent * tangent_space_normal.x
          + bitangent * tangent_space_normal.y
          + normal * tangent_space_normal.z,
        normal,
      );
    }
`
    : /* wgsl */ `let normal = safe_normalize3(input.normal, vec3f(0.0, 0.0, 1.0));`;
  const environmentLighting = materialTextures
    ? /* wgsl */ `
    if material_textures.normal_environment.y > 0.0 {
      let environment_intensity = material_textures.normal_environment.y;
      let environment_diffuse = sample_environment_cone(
        normal, 1.0, material_textures.normal_environment.w
      );
      let reflected = reflect(-view_direction, normal);
      let environment_specular = sample_environment_cone(
        reflected, roughness * roughness, material_textures.normal_environment.w
      );
      let diffuse_environment = color * (1.0 - metallic) * environment_diffuse;
      let specular_environment = mix(vec3f(0.04), color, metallic)
        * environment_specular;
      color += (diffuse_environment + specular_environment) * environment_intensity;
    }
`
    : "";
  return /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) shape: f32,
  @location(3) normal: vec3f,
  @location(4) material: vec4f,
  @location(5) world_position: vec3f,
  @location(6) shape_style_color: vec4f,
  @location(7) shape_style_parameters: vec4f,
  @location(8) gradient_style_color: vec4f,
  @location(9) gradient_style_parameters: vec4f,
  @location(10) tangent: vec4f,
}

struct AdditionalLight {
  direction_intensity: vec4f,
  color_padding: vec4f,
  position_kind: vec4f,
  range_cone: vec4f,
}

struct SceneLighting {
  direction_intensity: vec4f,
  color_ambient: vec4f,
  position_kind: vec4f,
  range_cone: vec4f,
  shadow_x_scale: vec4f,
  shadow_y_scale: vec4f,
  shadow_z_scale: vec4f,
  shadow_center_bias: vec4f,
  camera_position: vec4f,
  additional: array<AdditionalLight, ${MAX_SCENE_LIGHTS - 1}>,
}

@group(0) @binding(0) var<uniform> lighting: SceneLighting;
@group(0) @binding(1) var shadow_map: texture_depth_2d;
@group(0) @binding(2) var shadow_sampler: sampler_comparison;
${materialBindings}

fn safe_normalize3(value: vec3f, fallback: vec3f) -> vec3f {
  let length_squared = dot(value, value);
  if length_squared > 0.00000001 {
    return value * inverseSqrt(length_squared);
  }
  return fallback;
}

fn shadow_position(world_position: vec3f) -> vec3f {
  let relative = world_position - lighting.shadow_center_bias.xyz;
  return vec3f(
    dot(relative, lighting.shadow_x_scale.xyz) * lighting.shadow_x_scale.w,
    dot(relative, lighting.shadow_y_scale.xyz) * lighting.shadow_y_scale.w,
    0.5 - dot(relative, lighting.shadow_z_scale.xyz) * lighting.shadow_z_scale.w,
  );
}

@vertex
fn vertex_main(
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
  @location(3) shape: f32,
  @location(4) normal: vec3f,
  @location(5) material: vec4f,
  @location(6) world_position: vec3f,
  @location(7) shape_style_color: vec4f,
  @location(8) shape_style_parameters: vec4f,
  @location(9) gradient_style_color: vec4f,
  @location(10) gradient_style_parameters: vec4f,
  @location(11) tangent: vec4f,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position, 1.0);
  output.uv = uv;
  output.color = color;
  output.shape = shape;
  output.normal = normal;
  output.material = material;
  output.world_position = world_position;
  output.shape_style_color = shape_style_color;
  output.shape_style_parameters = shape_style_parameters;
  output.gradient_style_color = gradient_style_color;
  output.gradient_style_parameters = gradient_style_parameters;
  output.tangent = tangent;
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  var alpha = input.color.a;
  let uv_derivative = max(fwidth(input.uv.x), 0.0005);
  if input.shape_style_parameters.z > 0.5 {
    let centered = input.uv - vec2f(0.5);
    var fill_color = input.color.rgb;
    if input.gradient_style_parameters.x > 0.5 {
      let angle = input.gradient_style_parameters.y;
      let linear_amount = clamp(
        dot(centered, vec2f(cos(angle), sin(angle))) + 0.5,
        0.0,
        1.0,
      );
      let radial_amount = clamp(length(centered) * 1.41421356, 0.0, 1.0);
      let gradient_amount = select(
        linear_amount,
        radial_amount,
        input.gradient_style_parameters.x > 1.5,
      );
      fill_color = mix(fill_color, input.gradient_style_color.rgb, gradient_amount);
      alpha *= mix(1.0, input.gradient_style_color.a, gradient_amount);
    }
    if input.shape_style_parameters.z > 3.5 {
      return vec4f(fill_color * alpha, alpha);
    }
    let ellipse_distance = (length(centered * 2.0) - 1.0) * 0.5;
    let radius = input.shape_style_parameters.y;
    let rounded = abs(centered) - vec2f(0.5 - radius);
    let rectangle_distance = length(max(rounded, vec2f(0.0)))
      + min(max(rounded.x, rounded.y), 0.0) - radius;
    var shape_distance = select(
      rectangle_distance,
      ellipse_distance,
      input.shape_style_parameters.z > 1.5,
    );
    var dash_coverage = 1.0;
    if input.shape_style_parameters.z > 2.5 {
      let segment_start = vec2f(-0.5, 0.0);
      let segment = vec2f(1.0, 0.0);
      let relative = centered - segment_start;
      let along = clamp(dot(relative, segment) / dot(segment, segment), 0.0, 1.0);
      let line_radius = max(input.shape_style_parameters.x * 0.5, 0.003);
      shape_distance = select(
        max(abs(centered.y) - line_radius, abs(centered.x) - 0.5),
        length(relative - segment * along) - line_radius,
        input.shape_style_parameters.w > 0.5,
      );
      let dash = input.gradient_style_parameters.z;
      let gap = input.gradient_style_parameters.w;
      if dash > 0.0 && gap > 0.0 {
        let phase = fract(along / (dash + gap)) * (dash + gap);
        dash_coverage = 1.0 - smoothstep(dash, dash + uv_derivative, phase);
      }
    }
    let antialias = 0.006;
    let coverage = (1.0 - smoothstep(0.0, antialias, shape_distance)) * dash_coverage;
    let stroke_width = input.shape_style_parameters.x;
    var stroke_coverage = select(
      0.0,
      1.0 - smoothstep(stroke_width, stroke_width + antialias, abs(shape_distance)),
      stroke_width > 0.0,
    );
    if input.shape_style_parameters.z > 2.5 { stroke_coverage = 1.0; }
    let stroke_weight = stroke_coverage * input.shape_style_color.a;
    let fill_alpha = alpha * coverage * (1.0 - stroke_weight);
    let stroke_alpha = stroke_weight * input.material.w * coverage;
    return vec4f(
      fill_color * fill_alpha + input.shape_style_color.rgb * stroke_alpha,
      fill_alpha + stroke_alpha,
    );
  }
  let edge = min(min(input.uv.x, 1.0 - input.uv.x), min(input.uv.y, 1.0 - input.uv.y));
  alpha *= smoothstep(0.0, 0.025, edge);
  var color = input.color.rgb;
  if input.material.w > 0.5 {
    ${surfaceNormal}
    let to_light = lighting.position_kind.xyz - input.world_position;
    let distance_to_light = max(length(to_light), 0.001);
    let directional = lighting.position_kind.w < 0.5;
    let light_direction = select(
      safe_normalize3(to_light, vec3f(0.0, 0.0, 1.0)),
      safe_normalize3(lighting.direction_intensity.xyz, vec3f(0.0, 0.0, 1.0)),
      directional,
    );
    let normalized_distance = distance_to_light / max(lighting.range_cone.x, 1.0);
    var attenuation = select(1.0 / (1.0 + normalized_distance * normalized_distance * 4.0), 1.0, directional);
    if lighting.position_kind.w > 1.5 {
      let from_light = safe_normalize3(
        input.world_position - lighting.position_kind.xyz, vec3f(0.0, 0.0, -1.0)
      );
      let cone = dot(
        from_light,
        safe_normalize3(lighting.direction_intensity.xyz, vec3f(0.0, 0.0, 1.0)),
      );
      attenuation *= smoothstep(lighting.range_cone.y, min(1.0, lighting.range_cone.y + 0.08), cone);
    }
    let diffuse_weight = max(dot(normal, light_direction), 0.0);
    let view_direction = safe_normalize3(
      lighting.camera_position.xyz - input.world_position,
      vec3f(0.0, 0.0, -1.0),
    );
    let half_direction = safe_normalize3(light_direction + view_direction, light_direction);
    let roughness = clamp(input.material.y, 0.04, 1.0);
    let metallic = clamp(input.material.x, 0.0, 1.0);
    let specular_power = mix(160.0, 4.0, roughness);
    let fresnel = mix(vec3f(0.04), color, metallic);
    let specular = fresnel * pow(max(dot(normal, half_direction), 0.0), specular_power);
    let radiance = lighting.color_ambient.rgb * lighting.direction_intensity.w * attenuation;
    let shadow_coordinate = shadow_position(input.world_position);
    let shadow_uv = vec2f(shadow_coordinate.x * 0.5 + 0.5, 0.5 - shadow_coordinate.y * 0.5);
    let inside_shadow_map = all(shadow_uv >= vec2f(0.0)) && all(shadow_uv <= vec2f(1.0))
      && shadow_coordinate.z >= 0.0 && shadow_coordinate.z <= 1.0;
    var visibility = 1.0;
    if inside_shadow_map && lighting.position_kind.w != 1.0 && lighting.range_cone.z > 0.5 {
      let comparison = textureSampleCompareLevel(
        shadow_map,
        shadow_sampler,
        shadow_uv,
        shadow_coordinate.z - lighting.shadow_center_bias.w,
      );
      visibility = mix(0.32, 1.0, comparison);
    }
    let diffuse = color * (1.0 - metallic) * diffuse_weight * radiance * visibility;
    color = color * lighting.color_ambient.w + diffuse + specular * radiance * visibility;
    // Extra lights share this material pass; only the primary light samples a shadow map.
    for (var index = 0u; index < min(u32(lighting.camera_position.w), ${MAX_SCENE_LIGHTS - 1}u); index++) {
      let extra = lighting.additional[index];
      let extra_to_light = extra.position_kind.xyz - input.world_position;
      let extra_distance = max(length(extra_to_light), 0.001);
      let extra_directional = extra.position_kind.w < 0.5;
      let extra_direction = select(
        safe_normalize3(extra_to_light, vec3f(0.0, 0.0, 1.0)),
        extra.direction_intensity.xyz,
        extra_directional,
      );
      let extra_normalized_distance = extra_distance / max(extra.range_cone.x, 1.0);
      var extra_attenuation = select(
        1.0 / (1.0 + extra_normalized_distance * extra_normalized_distance * 4.0),
        1.0, extra_directional,
      );
      if extra.position_kind.w > 1.5 {
        let extra_from_light = safe_normalize3(-extra_to_light, vec3f(0.0, 0.0, -1.0));
        extra_attenuation *= smoothstep(
          extra.range_cone.y, min(1.0, extra.range_cone.y + 0.08),
          dot(extra_from_light, extra.direction_intensity.xyz),
        );
      }
      let extra_radiance = extra.color_padding.rgb * extra.direction_intensity.w * extra_attenuation;
      let extra_half = safe_normalize3(extra_direction + view_direction, extra_direction);
      let extra_specular = fresnel * pow(max(dot(normal, extra_half), 0.0), specular_power);
      color += (input.color.rgb * (1.0 - metallic) * max(dot(normal, extra_direction), 0.0)
        + extra_specular) * extra_radiance;
    }
    ${environmentLighting}
    color += input.color.rgb * max(input.material.z, 0.0);
    let alpha_mode = input.gradient_style_parameters.x;
    let material_alpha = max(input.shape_style_color.a, 0.00001);
    let layer_opacity = clamp(input.color.a / material_alpha, 0.0, 1.0);
    if alpha_mode < 0.5 {
      alpha = layer_opacity;
    } else if alpha_mode < 1.5 {
      if input.shape_style_color.a < input.gradient_style_parameters.y { discard; }
      alpha = layer_opacity;
    }
  }
  return vec4f(color * alpha, alpha);
}
`;
}

export const shadowShader = /* wgsl */ `
struct SceneLighting {
  direction_intensity: vec4f,
  color_ambient: vec4f,
  position_kind: vec4f,
  range_cone: vec4f,
  shadow_x_scale: vec4f,
  shadow_y_scale: vec4f,
  shadow_z_scale: vec4f,
  shadow_center_bias: vec4f,
}

@group(0) @binding(0) var<uniform> lighting: SceneLighting;

@vertex
fn vertex_main(@location(6) world_position: vec3f) -> @builtin(position) vec4f {
  let relative = world_position - lighting.shadow_center_bias.xyz;
  let x = dot(relative, lighting.shadow_x_scale.xyz) * lighting.shadow_x_scale.w;
  let y = dot(relative, lighting.shadow_y_scale.xyz) * lighting.shadow_y_scale.w;
  let depth = 0.5 - dot(relative, lighting.shadow_z_scale.xyz) * lighting.shadow_z_scale.w;
  return vec4f(x, y, depth, 1.0);
}
`;

export const imageShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) media_type: f32,
}

@group(0) @binding(0) var image_texture: texture_2d<f32>;
@group(0) @binding(1) var image_sampler: sampler;

@vertex
fn vertex_main(
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
  @location(3) shape: f32,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position, 1.0);
  output.uv = uv;
  output.color = color;
  output.media_type = shape;
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let sampled = textureSample(image_texture, image_sampler, input.uv);
  let source_alpha = select(sampled.a, 1.0, input.media_type > 1.5);
  let alpha = source_alpha * input.color.a;
  return vec4f(sampled.rgb * input.color.rgb * alpha, alpha);
}
`;

export const textureCompositeShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;

@vertex
fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)
  );
  let uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0)
  );
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(source_texture, source_sampler, input.uv);
}
`;
