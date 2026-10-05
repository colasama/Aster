import {
  type CameraOptics,
  DEFAULT_CAMERA_APERTURE_PIXELS,
  depthOfFieldSampleCount,
} from "../../core/scene/camera-optics";
import { requirePlan } from "../frame-plan/canonical";
import type { DepthInputs } from "../frame-plan/post-effect-layout";
import { buildPostEffectPlan, readPostEffectPlan } from "../frame-plan/post-effect-plan";
import type { FrameHeaderSlice, FramePlanSliceData } from "../frame-plan/types";
import type { DepthEffectVisualization } from "../gpu/render-buffers";
import { sharedShaders } from "../gpu/shared-shader-catalog";

export interface DepthEffectSettings {
  cameraPosition: readonly [number, number, number];
  cameraForward: readonly [number, number, number];
  fogColor: readonly [number, number, number];
  fogDensity: number;
  fogStart: number;
  focusDistance: number;
  focusAreaWidth: number;
  aperture: number;
  filmSize: number;
  transparencyTier: number;
  zoom: number;
  blurLevel: number;
  nearBlurLevel: number;
  farBlurLevel: number;
  irisShapeCode: number;
  irisRotation: number;
  irisRoundness: number;
  irisAspectRatio: number;
  irisDiffractionFringe: number;
  highlightGain: number;
  highlightThreshold: number;
  highlightSaturation: number;
  maximumBlurRadius: number;
  sampleCount: number;
}

export const DEFAULT_DEPTH_EFFECT_SETTINGS: DepthEffectSettings = {
  cameraPosition: [0, 0, 0],
  cameraForward: [0, 0, 1],
  fogColor: [0.08, 0.16, 0.3],
  fogDensity: 0.012,
  fogStart: 6,
  focusDistance: 2666.666_666_666_666_5,
  focusAreaWidth: 0,
  aperture: DEFAULT_CAMERA_APERTURE_PIXELS,
  filmSize: 36,
  transparencyTier: 2,
  zoom: 2666.666_666_666_666_5,
  blurLevel: 100,
  nearBlurLevel: 100,
  farBlurLevel: 100,
  irisShapeCode: 1,
  irisRotation: 0,
  irisRoundness: 0,
  irisAspectRatio: 1,
  irisDiffractionFringe: 0,
  highlightGain: 0,
  highlightThreshold: 1,
  highlightSaturation: 100,
  maximumBlurRadius: 48,
  sampleCount: 32,
};

export {
  applyDepthOfFieldHighlight,
  depthEffectCircleOfConfusion,
  depthOfFieldDiffractionWeights,
  type LayeredDepthOfFieldColors,
  type LayeredDepthOfFieldPlan,
  planLayeredDepthOfField,
  resolveLayeredDepthOfFieldColors,
} from "./depth-effects-math";

export function depthEffectSettingsFromCameraOptics(
  optics: CameraOptics,
  compositionWidth: number,
  renderWidth: number,
): Omit<
  DepthEffectSettings,
  "cameraPosition" | "cameraForward" | "fogColor" | "fogDensity" | "fogStart"
> {
  const resolutionScale = bounded(renderWidth, 1, 32_768) / bounded(compositionWidth, 1, 32_768);
  return {
    focusDistance: optics.focusDistance,
    focusAreaWidth: optics.focusAreaWidth,
    aperture: optics.aperture * resolutionScale,
    filmSize: optics.filmSize,
    transparencyTier: 2,
    zoom: optics.zoom,
    blurLevel: optics.blurLevel,
    nearBlurLevel: optics.nearBlurLevel,
    farBlurLevel: optics.farBlurLevel,
    irisShapeCode: optics.irisShapeCode,
    irisRotation: optics.irisRotation,
    irisRoundness: optics.irisRoundness,
    irisAspectRatio: optics.irisAspectRatio,
    irisDiffractionFringe: optics.irisDiffractionFringe,
    highlightGain: optics.highlightGain,
    highlightThreshold: optics.highlightThreshold,
    highlightSaturation: optics.highlightSaturation,
    maximumBlurRadius: Math.max(1, Math.min(256, 256 * resolutionScale)),
    sampleCount: depthOfFieldSampleCount(optics.renderQuality),
  };
}

const MODE_CODES: Readonly<Record<DepthEffectVisualization, number>> = {
  depthFog: 1,
  depthOfField: 2,
};

/** Packs eight aligned vec4 uniforms for the depth-aware fullscreen pass. */
export function buildDepthEffectUniforms(
  mode: DepthEffectVisualization,
  width: number,
  height: number,
  settings: DepthEffectSettings = DEFAULT_DEPTH_EFFECT_SETTINGS,
): Float32Array {
  return new Float32Array([
    bounded(width, 1, 16_384),
    bounded(height, 1, 16_384),
    MODE_CODES[mode],
    bounded(settings.sampleCount, 8, 64),
    bounded(settings.fogColor[0], 0, 16),
    bounded(settings.fogColor[1], 0, 16),
    bounded(settings.fogColor[2], 0, 16),
    bounded(settings.fogDensity, 0, 1),
    finite(settings.cameraPosition[0], 0),
    finite(settings.cameraPosition[1], 0),
    finite(settings.cameraPosition[2], 0),
    bounded(settings.fogStart, 0, 100_000),
    finite(settings.cameraForward[0], 0),
    finite(settings.cameraForward[1], 0),
    finite(settings.cameraForward[2], 1),
    bounded(settings.focusDistance, 0.001, 10_000_000),
    bounded(settings.focusAreaWidth, 0, 10_000_000),
    bounded(settings.aperture, 0, 10_000),
    bounded(settings.transparencyTier, 0, 2),
    bounded(settings.zoom, 0.001, 10_000_000),
    bounded(settings.blurLevel, 0, 1_000) / 100,
    bounded(settings.nearBlurLevel, 0, 1_000) / 100,
    bounded(settings.farBlurLevel, 0, 1_000) / 100,
    bounded(settings.maximumBlurRadius, 0, 256),
    bounded(settings.irisShapeCode, 1, 10),
    (bounded(settings.irisRotation, -360, 360) * Math.PI) / 180,
    bounded(settings.irisRoundness, 0, 100) / 100,
    bounded(settings.irisAspectRatio, 1, 100),
    bounded(settings.irisDiffractionFringe, 0, 100) / 100,
    bounded(settings.highlightGain, 0, 100) / 100,
    bounded(settings.highlightThreshold, 0, 1),
    bounded(settings.highlightSaturation, 0, 100) / 100,
  ]);
}

/** GPU-only depth fog and bounded depth-of-field preview pass. */
export class DepthEffectsRenderer {
  readonly #device: GPUDevice;
  readonly #pipeline: GPURenderPipeline;
  readonly #sampler: GPUSampler;
  readonly #uniform: GPUBuffer;
  #sources: Partial<Record<DepthInputs[number], GPUTexture>> = {};
  #inputs: DepthInputs = [
    "scene",
    "worldPosition",
    "worldPosition",
    "worldPosition",
    "scene",
    "scene",
  ];
  #width = 1;
  #height = 1;
  #settings: DepthEffectSettings = DEFAULT_DEPTH_EFFECT_SETTINGS;

  constructor(device: GPUDevice, outputFormat: GPUTextureFormat) {
    this.#device = device;
    const module = device.createShaderModule({
      label: "Depth fog and depth-of-field shader",
      code: depthEffectsShader,
    });
    this.#pipeline = device.createRenderPipeline({
      label: "Depth-aware fog and depth-of-field pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: { module, entryPoint: "fragment_main", targets: [{ format: outputFormat }] },
      primitive: { topology: "triangle-list" },
    });
    this.#sampler = device.createSampler({
      label: "Depth effects scene sampler",
      magFilter: "linear",
      minFilter: "linear",
    });
    this.#uniform = device.createBuffer({
      label: "Depth effects uniforms",
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  setSources(
    width: number,
    height: number,
    scene: GPUTexture | undefined,
    worldPosition: GPUTexture | undefined,
    transparentWorldPosition: GPUTexture | undefined,
    peeledWorldPosition: GPUTexture | undefined,
    frontLayerColor: GPUTexture | undefined,
    peeledLayerColor: GPUTexture | undefined,
    sceneRole: "scene" | "motion_blur" = "scene",
  ): void {
    this.#width = width;
    this.#height = height;
    this.#sources = {
      [sceneRole]: scene,
      worldPosition,
      transparentWorldPosition,
      peeledWorldPosition,
      frontLayerColor,
      peeledLayerColor,
    };
    this.#inputs = [
      sceneRole,
      "worldPosition",
      transparentWorldPosition ? "transparentWorldPosition" : "worldPosition",
      peeledWorldPosition ? "peeledWorldPosition" : "worldPosition",
      frontLayerColor ? "frontLayerColor" : sceneRole,
      peeledLayerColor ? "peeledLayerColor" : sceneRole,
    ];
  }

  setSettings(settings: Partial<DepthEffectSettings>): void {
    this.#settings = { ...this.#settings, ...settings };
  }

  buildPlan(header: FrameHeaderSlice, mode: DepthEffectVisualization): FramePlanSliceData {
    const floats = buildDepthEffectUniforms(
      mode,
      header.render_target.width,
      header.render_target.height,
      this.#settings,
    );
    const bytes = new Uint8Array(floats.byteLength),
      view = new DataView(bytes.buffer);
    floats.forEach((value, i) => {
      view.setFloat32(i * 4, value, true);
    });
    return buildPostEffectPlan(
      header,
      { kind: "depth", mode, inputs: this.#inputs },
      this.#inputs.every((role) => this.#sources[role] !== undefined),
      bytes,
    );
  }

  preparePlan(input: FramePlanSliceData): (pass: GPURenderPassEncoder) => boolean {
    const plan = readPostEffectPlan(input);
    requirePlan(plan.slice.effect.kind === "depth", "invalid_header", "Expected depth effect plan");
    if (plan.slice.status === "skipped") return () => false;
    requirePlan(
      this.#width === plan.header.render_target.width &&
        this.#height === plan.header.render_target.height,
      "resource_generation_mismatch",
      "Depth attachment dimensions differ from the plan",
    );
    const textures = plan.slice.effect.inputs.map((role) => {
      const texture = this.#sources[role];
      requirePlan(texture, "missing_resource", `Missing planned depth attachment: ${role}`);
      return texture;
    });
    const bindGroup = this.#device.createBindGroup({
      label: "Depth effects HDR + world-position resources",
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: textures[0].createView() },
        { binding: 1, resource: textures[1].createView() },
        { binding: 2, resource: this.#sampler },
        { binding: 3, resource: { buffer: this.#uniform } },
        ...textures
          .slice(2)
          .map((texture, i) => ({ binding: i + 4, resource: texture.createView() })),
      ],
    });
    this.#device.queue.writeBuffer(this.#uniform, 0, plan.uniforms);
    return (pass) => {
      pass.setPipeline(this.#pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      return true;
    };
  }

  destroy(): void {
    this.#sources = {};
    this.#uniform.destroy();
  }
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

export const depthEffectsShader = sharedShaders.source("depth-effects");
