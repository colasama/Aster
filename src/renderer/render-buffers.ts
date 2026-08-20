export const AUXILIARY_BUFFER_KINDS = [
  "normal",
  "objectId",
  "materialId",
  "worldPosition",
] as const;

export type AuxiliaryBufferKind = (typeof AUXILIARY_BUFFER_KINDS)[number];
export const SCENE_BUFFER_VISUALIZATIONS = ["beauty", "linearColor", "luminance", "alpha"] as const;
export type SceneBufferVisualization = (typeof SCENE_BUFFER_VISUALIZATIONS)[number];
export type BufferVisualization = SceneBufferVisualization | AuxiliaryBufferKind;

export interface AuxiliaryBufferDescriptor {
  kind: AuxiliaryBufferKind;
  label: string;
  format: GPUTextureFormat;
  bytesPerPixel: number;
  sampleType: "float" | "uint";
  clearValue: GPUColor;
}

export interface AuxiliaryBufferPlan {
  width: number;
  height: number;
  estimatedBytes: number;
  attachments: readonly AuxiliaryBufferDescriptor[];
}

export const AUXILIARY_BUFFER_DESCRIPTORS: Readonly<
  Record<AuxiliaryBufferKind, AuxiliaryBufferDescriptor>
> = {
  normal: {
    kind: "normal",
    label: "View-space normals",
    format: "rgba16float",
    bytesPerPixel: 8,
    sampleType: "float",
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
  },
  objectId: {
    kind: "objectId",
    label: "Object IDs",
    format: "r32uint",
    bytesPerPixel: 4,
    sampleType: "uint",
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
  },
  materialId: {
    kind: "materialId",
    label: "Material IDs",
    format: "r32uint",
    bytesPerPixel: 4,
    sampleType: "uint",
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
  },
  worldPosition: {
    kind: "worldPosition",
    label: "World positions",
    format: "rgba16float",
    bytesPerPixel: 8,
    sampleType: "float",
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
  },
};

const MAX_DIMENSION = 16_384;
const MAX_AUXILIARY_BYTES = 1024 * 1024 * 1024;

export function planAuxiliaryBuffers(
  width: number,
  height: number,
  enabled: readonly AuxiliaryBufferKind[] = AUXILIARY_BUFFER_KINDS,
  byteBudget = MAX_AUXILIARY_BYTES,
): AuxiliaryBufferPlan {
  const safeWidth = boundedDimension(width);
  const safeHeight = boundedDimension(height);
  const unique = [...new Set(enabled)];
  const attachments = unique.map((kind) => AUXILIARY_BUFFER_DESCRIPTORS[kind]);
  const estimatedBytes = attachments.reduce(
    (bytes, attachment) => bytes + safeWidth * safeHeight * attachment.bytesPerPixel,
    0,
  );
  if (estimatedBytes > Math.max(0, byteBudget)) {
    throw new Error(
      `Auxiliary render buffers require ${estimatedBytes} bytes, exceeding the ${byteBudget}-byte budget`,
    );
  }
  return { width: safeWidth, height: safeHeight, estimatedBytes, attachments };
}

export function createAuxiliaryBufferTextures(
  device: GPUDevice,
  plan: AuxiliaryBufferPlan,
): ReadonlyMap<AuxiliaryBufferKind, GPUTexture> {
  const textures = new Map<AuxiliaryBufferKind, GPUTexture>();
  try {
    for (const attachment of plan.attachments) {
      textures.set(
        attachment.kind,
        device.createTexture({
          label: attachment.label,
          size: [plan.width, plan.height],
          format: attachment.format,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_SRC,
        }),
      );
    }
    return textures;
  } catch (error) {
    destroyAuxiliaryBufferTextures(textures);
    throw error;
  }
}

export function destroyAuxiliaryBufferTextures(
  textures: ReadonlyMap<AuxiliaryBufferKind, GPUTexture>,
): void {
  for (const texture of textures.values()) texture.destroy();
}

/** Stable non-zero 32-bit ID for integer render targets. */
export function encodeRenderId(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0 || 1;
}

/** Uniforms shared by float-buffer visualization: mode, range minimum, reciprocal range, padding. */
export function buildBufferVisualizationUniforms(
  mode: BufferVisualization,
  range: readonly [number, number] = [-1000, 1000],
): Float32Array {
  const minimum = Number.isFinite(range[0]) ? range[0] : -1000;
  const maximum = Number.isFinite(range[1]) ? range[1] : 1000;
  const span = Math.max(maximum - minimum, 1e-6);
  return new Float32Array([visualizationCode(mode), minimum, 1 / span, 0]);
}

export function visualizationCode(mode: BufferVisualization): number {
  return ["beauty", ...AUXILIARY_BUFFER_KINDS].indexOf(mode);
}

export const FLOAT_BUFFER_VISUALIZATION_WGSL = /* wgsl */ `
struct DebugSettings { mode: u32, range_min: f32, range_scale: f32, padding: f32 }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> settings: DebugSettings;

fn visualize_float_buffer(pixel: vec4f) -> vec4f {
  if (settings.mode == 1u) { return vec4f(pixel.xyz * 0.5 + 0.5, 1.0); }
  if (settings.mode == 4u) {
    return vec4f(clamp((pixel.xyz - settings.range_min) * settings.range_scale, vec3f(0.0), vec3f(1.0)), 1.0);
  }
  return pixel;
}`;

export const UINT_BUFFER_VISUALIZATION_WGSL = /* wgsl */ `
fn hash_id(id: u32) -> vec3f {
  var value = id ^ (id >> 16u);
  value *= 0x7feb352du;
  value ^= value >> 15u;
  value *= 0x846ca68bu;
  value ^= value >> 16u;
  return vec3f(f32(value & 255u), f32((value >> 8u) & 255u), f32((value >> 16u) & 255u)) / 255.0;
}

fn visualize_id(id: u32) -> vec4f {
  if (id == 0u) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  return vec4f(hash_id(id), 1.0);
}`;

function boundedDimension(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Render buffer dimensions must be finite");
  return Math.min(MAX_DIMENSION, Math.max(1, Math.floor(value)));
}
