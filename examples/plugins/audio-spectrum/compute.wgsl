struct AsterGeneratorContext {
  resolution: vec2f, composition_time: f32, local_time: f32,
  frame_duration: f32, reserved_time: f32, instance_count: u32, instance_seed: u32,
  layer_position_opacity: vec4f, layer_rotation: vec4f, layer_scale: vec4f,
  camera_position: vec4f, camera_rotation: vec4f, camera_projection: vec4f,
  composition: vec4f, ids: vec4u,
  camera_right: vec4f, camera_down: vec4f, camera_forward: vec4f,
}
struct AsterGeneratorParameters { values: array<vec4f, 128> }
struct AsterDrawIndirect {
  vertex_count: u32, instance_count: atomic<u32>, first_vertex: u32, first_instance: u32,
}
struct AsterAudioAnalysis {
  info: vec4u,
  timing: vec4f,
  levels: vec4f,
  energy: vec4f,
  spectrum: array<f32, 2048>,
  waveform: array<f32, 256>,
}

// One oriented element in layer pixels (y down). The render pass expands it into a quad.
struct Element {
  base: vec2f,
  axis: vec2f,
  // x: half width, y: track length, z: level length, w: peak length
  size: vec4f,
  color: vec4f,
  // x: kind (0 bar, 1 mirrored bar, 2 segment, 3 dots), y: dot rows, z: roundness, w: glow
  shape: vec4f,
}

@group(0) @binding(0) var<uniform> aster_context: AsterGeneratorContext;
@group(0) @binding(1) var<uniform> aster_parameters: AsterGeneratorParameters;
@group(0) @binding(2) var<storage, read_write> aster_instances: array<Element>;
@group(0) @binding(3) var<storage, read_write> aster_draw: AsterDrawIndirect;
@group(0) @binding(4) var<storage, read> aster_audio: AsterAudioAnalysis;

const STYLE_BARS = 0u;
const STYLE_MIRROR = 1u;
const STYLE_RING = 2u;
const STYLE_LINE = 3u;
const STYLE_SCOPE = 4u;
const STYLE_DOTS = 5u;
const BANDS = 128u;
const HISTORY = 16u;
const ANALYSIS_MIN_HZ = 30.0;
const ANALYSIS_MAX_HZ = 16000.0;
const CAP_GRAVITY = 16.0;
const TAU = 6.28318530718;

fn parameter(index: u32) -> f32 { return aster_parameters.values[index].x; }

fn audio_present() -> bool { return (aster_audio.info.w & 1u) != 0u; }

fn band(frame: u32, position: f32) -> f32 {
  let x = clamp(position, 0.0, f32(BANDS - 1u));
  let lower = u32(floor(x));
  let upper = min(lower + 1u, BANDS - 1u);
  let offset = frame * BANDS;
  return mix(aster_audio.spectrum[offset + lower], aster_audio.spectrum[offset + upper], x - floor(x));
}

fn smoothed_band(frame: u32, position: f32, spread: f32) -> f32 {
  if spread < 0.01 { return band(frame, position); }
  return band(frame, position) * 0.4
    + (band(frame, position - spread) + band(frame, position + spread)) * 0.24
    + (band(frame, position - spread * 2.0) + band(frame, position + spread * 2.0)) * 0.06;
}

fn shape_value(raw: f32, frequency: f32) -> f32 {
  // Band values are dBFS mapped from -90..0 to 0..1, so one dB is 1/90.
  let tilted = raw + parameter(10) * log2(frequency / 1000.0) / 90.0;
  let span = max(parameter(9) - parameter(8), 0.001);
  return pow(clamp((tilted - parameter(8)) / span, 0.0, 1.0), parameter(11));
}

// Level and falling peak for a normalized spectrum position; history keeps it seek-safe.
fn spectrum_level(t: f32, count: f32) -> vec2f {
  if !audio_present() { return vec2f(0.0); }
  let low = clamp(min(parameter(13), parameter(14)), ANALYSIS_MIN_HZ, ANALYSIS_MAX_HZ);
  let high = clamp(max(parameter(13), parameter(14)), ANALYSIS_MIN_HZ, ANALYSIS_MAX_HZ * 0.999);
  let octaves = log2(ANALYSIS_MAX_HZ / ANALYSIS_MIN_HZ);
  let frequency = low * pow(high / max(low, 1.0), t);
  let position = log2(frequency / ANALYSIS_MIN_HZ) / octaves * f32(BANDS) - 0.5;
  let element_bands = log2(high / max(low, 1.0)) / octaves * f32(BANDS) / max(count, 1.0);
  // A continuous curve exposes band noise that separate bars hide, so lines smooth harder.
  let curve_smoothing = select(1.0, 3.0, u32(parameter(0) + 0.5) == STYLE_LINE);
  let spread = max(element_bands, 1.0) * parameter(15) * curve_smoothing;
  let hop = aster_audio.timing.y;
  let release = max(parameter(12), 0.0001);
  var level = 0.0;
  var peak = 0.0;
  for (var frame = 0u; frame < HISTORY; frame += 1u) {
    let value = shape_value(smoothed_band(frame, position, spread), frequency);
    let age = f32(frame) * hop;
    level = max(level, value * exp(-age / release));
    peak = max(peak, value - CAP_GRAVITY * age * age);
  }
  return vec2f(level, max(peak, level));
}

fn scope_sample(t: f32) -> f32 {
  if !audio_present() { return 0.0; }
  let x = clamp(t, 0.0, 1.0) * 255.0;
  let lower = u32(floor(x));
  let upper = min(lower + 1u, 255u);
  return mix(aster_audio.waveform[lower], aster_audio.waveform[upper], x - floor(x));
}

fn curve_point(style: u32, t: f32, count: f32) -> vec2f {
  let x = (t - 0.5) * parameter(2);
  if style == STYLE_SCOPE {
    return vec2f(x, -scope_sample(t) * parameter(27) * parameter(3) * 0.5);
  }
  return vec2f(x, -spectrum_level(t, count).x * parameter(3));
}

fn tint(t: f32, level: f32, bass: f32) -> vec4f {
  let low = aster_parameters.values[16];
  let high = aster_parameters.values[17];
  let base = mix(low, high, clamp(t, 0.0, 1.0));
  let energy = (0.7 + 0.3 * level) * (1.0 + 0.5 * parameter(25) * bass);
  return vec4f(base.rgb * parameter(18) * energy, base.a);
}

@compute @workgroup_size(64)
fn compute_main(@builtin(global_invocation_id) id: vec3u) {
  let count = aster_context.instance_count;
  let index = id.x;
  if index >= count { return; }
  let style = u32(parameter(0) + 0.5);
  let n = f32(count);
  let bass = select(0.0, aster_audio.energy.x, audio_present());
  let glow = parameter(19);
  var element: Element;

  if style == STYLE_LINE || style == STYLE_SCOPE {
    // N points make N - 1 capsule segments.
    if index + 1u >= count { return; }
    let t0 = f32(index) / (n - 1.0);
    let t1 = f32(index + 1u) / (n - 1.0);
    let a = curve_point(style, t0, n);
    let b = curve_point(style, t1, n);
    let delta = b - a;
    let length_px = length(delta);
    let level = select(
      spectrum_level((t0 + t1) * 0.5, n).x,
      min(1.0, abs(scope_sample((t0 + t1) * 0.5)) * parameter(27)),
      style == STYLE_SCOPE,
    );
    element.base = a;
    element.axis = select(vec2f(0.0, -1.0), delta / max(length_px, 0.0001), length_px > 0.0001);
    element.size = vec4f(parameter(6) * 0.5, length_px, length_px, length_px);
    element.color = tint((t0 + t1) * 0.5, level, bass);
    element.shape = vec4f(2.0, 0.0, 1.0, glow);
  } else {
    let u = (f32(index) + 0.5) / n;
    let height = parameter(3);
    var t = u;
    var kind = 0.0;
    if style == STYLE_MIRROR {
      t = abs(u - 0.5) * 2.0;
      kind = 1.0;
    } else if style == STYLE_RING {
      t = 1.0 - abs(u * 2.0 - 1.0);
    } else if style == STYLE_DOTS {
      kind = 3.0;
    }
    let level = spectrum_level(t, select(n, n * 0.5, style == STYLE_MIRROR || style == STYLE_RING));
    var pitch = parameter(2) / n;
    if style == STYLE_RING {
      let angle = u * TAU + radians(parameter(26) * aster_context.local_time);
      let radius = parameter(4) * (1.0 + 0.2 * parameter(25) * bass);
      let direction = vec2f(sin(angle), -cos(angle));
      pitch = TAU * max(radius, 1.0) / n;
      element.base = direction * radius;
      element.axis = direction;
    } else {
      element.base = vec2f((u - 0.5) * parameter(2), 0.0);
      element.axis = vec2f(0.0, -1.0);
    }
    element.size = vec4f(pitch * parameter(5) * 0.5, height, level.x * height, level.y * height);
    element.color = tint(t, level.x, bass);
    element.shape = vec4f(kind, parameter(24), parameter(7), glow);
  }
  let output = atomicAdd(&aster_draw.instance_count, 1u);
  aster_instances[output] = element;
}
