
fn rotate_xyz(value: vec3f, degrees: vec3f) -> vec3f {
  let angle = degrees * 0.01745329252;
  var result = value;
  result = vec3f(result.x, result.y * cos(angle.x) - result.z * sin(angle.x), result.y * sin(angle.x) + result.z * cos(angle.x));
  result = vec3f(result.x * cos(angle.y) + result.z * sin(angle.y), result.y, -result.x * sin(angle.y) + result.z * cos(angle.y));
  return vec3f(result.x * cos(angle.z) - result.y * sin(angle.z), result.x * sin(angle.z) + result.y * cos(angle.z), result.z);
}

fn inverse_rotate_xyz(value: vec3f, degrees: vec3f) -> vec3f {
  let angle = -degrees * 0.01745329252;
  var result = value;
  result = vec3f(result.x * cos(angle.z) - result.y * sin(angle.z), result.x * sin(angle.z) + result.y * cos(angle.z), result.z);
  result = vec3f(result.x * cos(angle.y) + result.z * sin(angle.y), result.y, -result.x * sin(angle.y) + result.z * cos(angle.y));
  return vec3f(result.x, result.y * cos(angle.x) - result.z * sin(angle.x), result.y * sin(angle.x) + result.z * cos(angle.x));
}

fn generator_world(local: vec3f) -> vec3f {
  let composition_size = aster_context.composition.xy;
  let local_pixels = vec3f(local.x, -local.y, local.z) * composition_size.y * 0.5;
  let scaled = local_pixels * aster_context.layer_scale.xyz * 0.01;
  return aster_context.layer_position_opacity.xyz + rotate_xyz(scaled, aster_context.layer_rotation.xyz);
}

fn generator_clip(local: vec3f) -> vec3f {
  let world = generator_world(local);
  let composition_size = aster_context.composition.xy;
  if aster_context.layer_rotation.w < 0.5 {
    return vec3f(
      world.x / composition_size.x * 2.0 - 1.0,
      1.0 - world.y / composition_size.y * 2.0,
      clamp(0.5 - world.z / max(composition_size.y * 2.0, 1.0), 0.001, 0.999),
    );
  }
  let relative = world - aster_context.camera_position.xyz;
  let view = vec3f(
    dot(relative, aster_context.camera_right.xyz),
    dot(relative, aster_context.camera_down.xyz),
    dot(relative, aster_context.camera_forward.xyz),
  );
  let projection = aster_context.camera_projection;
  let perspective = select(
    projection.w / max(view.z, 0.000001),
    composition_size.y / max(projection.z, 1.0),
    projection.x > 0.5,
  );
  let near = 0.1;
  let far = 10000000.0;
  let perspective_depth = far / (far - near) - (far * near) / ((far - near) * max(view.z, 0.000001));
  let orthographic_depth = (view.z - near) / (far - near);
  return vec3f(
    view.x * perspective / composition_size.x * 2.0,
    -view.y * perspective / composition_size.y * 2.0,
    clamp(select(perspective_depth, orthographic_depth, projection.x > 0.5), 0.001, 0.999),
  );
}
