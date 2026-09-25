import type { BlendMode, GpuDiagnostics } from "../core/types";
import { MotionBlurRenderer } from "./compositing/motion-blur-renderer";
import { PrecompositionSurfaceRenderer } from "./compositing/precomposition-surface-renderer";
import { SceneBufferVisualizer } from "./diagnostics/buffer-visualizer";
import { GpuTimestampProfiler } from "./diagnostics/gpu-timestamp-profiler";
import { DepthEffectsRenderer } from "./effects/depth-effects";
import { FLOATS_PER_EFFECT_OPERATION, MAX_EFFECT_OPERATIONS } from "./effects/effect-program";
import { LayerEffectRenderer } from "./effects/layer-effects";
import { SurfacePostEffectsRenderer } from "./effects/surface-post-effects";
import { FLOATS_PER_VERTEX } from "./geometry/geometry";
import { AuxiliaryBufferRenderer } from "./gpu/auxiliary-buffer-renderer";
import { GpuFrameReadbackPool } from "./gpu/frame-readback";
import { createPostPipeline } from "./gpu/runtime-pipelines";
import { createLutSampler, createLutTexture } from "./media/lut-texture";
import type { MaterialTextureRenderer } from "./media/material-textures";
import { MediaTextureCache } from "./media/media-texture-cache";
import { bundledParticleDefinition } from "./scene/bundled-particle-generator";
import { SceneGeneratorHost } from "./scene/scene-generator-host";
import { SCENE_LIGHTING_BYTES } from "./scene/scene-lighting";
import {
  createImagePipelines,
  createShadowPipeline,
  createShapePipelines,
} from "./scene/scene-pipelines";

const MAX_SHAPE_VERTICES = 6 * 128;
const SCENE_FORMAT: GPUTextureFormat = "rgba16float";
const DEFAULT_SHADOW_MAP_SIZE = 1024;
/** Owns GPU allocations and the media/surface caches that share them across frames. */
export class RendererResources {
  readonly lightingBindGroupLayout: GPUBindGroupLayout;

  readonly lightingBuffer: GPUBuffer;

  lightingBindGroup: GPUBindGroup;

  readonly shadowBindGroup: GPUBindGroup;

  shadowTexture: GPUTexture;

  readonly shadowSampler: GPUSampler;

  readonly shadowPipeline: GPURenderPipeline;

  readonly shapePipelines: Record<BlendMode, GPURenderPipeline>;

  readonly imageBindGroupLayout: GPUBindGroupLayout;

  readonly imagePipelines: Record<BlendMode, GPURenderPipeline>;

  readonly sceneGenerators: SceneGeneratorHost;

  readonly postPipeline: GPURenderPipeline;

  readonly bufferVisualizer: SceneBufferVisualizer;

  readonly depthEffects: DepthEffectsRenderer;

  readonly motionBlur: MotionBlurRenderer;

  readonly surfacePostEffects: SurfacePostEffectsRenderer;

  readonly auxiliaryBuffers: AuxiliaryBufferRenderer;

  readonly layerEffects: LayerEffectRenderer;

  materialTextures?: MaterialTextureRenderer;

  shapeBuffer: GPUBuffer;

  readonly postSampler: GPUSampler;

  readonly lutSampler: GPUSampler;

  readonly identityLut: GPUTexture;

  readonly imageSampler: GPUSampler;

  readonly postUniformBuffer: GPUBuffer;

  readonly effectProgramBuffer: GPUBuffer;

  readonly gpuProfiler: GpuTimestampProfiler;

  readonly frameReadback: GpuFrameReadbackPool;

  postBindGroup?: GPUBindGroup;

  motionBlurPostBindGroup?: GPUBindGroup;

  sceneTexture?: GPUTexture;

  depthTexture?: GPUTexture;

  shadowMapSize = DEFAULT_SHADOW_MAP_SIZE;

  shapeBufferBytes = MAX_SHAPE_VERTICES * FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT;

  readonly mediaTextures: MediaTextureCache;

  readonly precompositionSurfaces: PrecompositionSurfaceRenderer;

  constructor(
    readonly device: GPUDevice,
    format: GPUTextureFormat,
    diagnostics: GpuDiagnostics,
    invalidate: () => void,
  ) {
    this.gpuProfiler = new GpuTimestampProfiler(device, diagnostics.timestampQueries, invalidate);
    this.frameReadback = new GpuFrameReadbackPool(device, format);
    this.lightingBindGroupLayout = device.createBindGroupLayout({
      label: "Scene lighting layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "depth", viewDimension: "2d" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "comparison" },
        },
      ],
    });
    this.lightingBuffer = device.createBuffer({
      label: "Scene lighting uniforms",
      size: SCENE_LIGHTING_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const shadowBindGroupLayout = device.createBindGroupLayout({
      label: "Shadow depth uniform layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
      ],
    });
    this.shadowBindGroup = device.createBindGroup({
      label: "Shadow depth uniforms",
      layout: shadowBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.lightingBuffer } }],
    });
    this.shadowTexture = device.createTexture({
      label: "Scene shadow map · 1024²",
      size: [DEFAULT_SHADOW_MAP_SIZE, DEFAULT_SHADOW_MAP_SIZE],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shadowSampler = device.createSampler({
      label: "Scene shadow comparison sampler",
      compare: "less-equal",
      minFilter: "linear",
      magFilter: "linear",
    });
    this.lightingBindGroup = device.createBindGroup({
      label: "Scene lighting resources",
      layout: this.lightingBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.lightingBuffer } },
        { binding: 1, resource: this.shadowTexture.createView() },
        { binding: 2, resource: this.shadowSampler },
      ],
    });
    this.shapePipelines = createShapePipelines(device, SCENE_FORMAT, this.lightingBindGroupLayout);
    this.shadowPipeline = createShadowPipeline(device, shadowBindGroupLayout);
    this.imageBindGroupLayout = device.createBindGroupLayout({
      label: "Imported media texture layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });
    this.imagePipelines = createImagePipelines(device, SCENE_FORMAT, this.imageBindGroupLayout);
    this.shapeBuffer = device.createBuffer({
      label: "Dynamic layer geometry",
      size: this.shapeBufferBytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    });
    this.sceneGenerators = new SceneGeneratorHost(device, SCENE_FORMAT, [
      bundledParticleDefinition,
    ]);
    this.auxiliaryBuffers = new AuxiliaryBufferRenderer(device, this.imageBindGroupLayout);
    this.postSampler = device.createSampler({
      label: "HDR linear sampler",
      magFilter: "linear",
      minFilter: "linear",
    });
    this.lutSampler = createLutSampler(device);
    this.identityLut = createLutTexture(device);
    this.imageSampler = device.createSampler({
      label: "Imported image sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
    });
    this.mediaTextures = new MediaTextureCache(
      device,
      this.imageBindGroupLayout,
      this.imageSampler,
      invalidate,
    );
    this.precompositionSurfaces = new PrecompositionSurfaceRenderer(device, {
      mediaTextures: this.mediaTextures,
      mediaLayout: this.imageBindGroupLayout,
      mediaSampler: this.imageSampler,
      lightingLayout: this.lightingBindGroupLayout,
      shapePipelines: this.shapePipelines,
      imagePipelines: this.imagePipelines,
      sceneGenerators: this.sceneGenerators,
    });
    this.postUniformBuffer = device.createBuffer({
      label: "Fused post-process uniforms",
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.effectProgramBuffer = device.createBuffer({
      label: "Compiled GPU effect program",
      size: MAX_EFFECT_OPERATIONS * FLOATS_PER_EFFECT_OPERATION * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.postPipeline = createPostPipeline(device, format);
    this.bufferVisualizer = new SceneBufferVisualizer(device, format);
    this.depthEffects = new DepthEffectsRenderer(device, format);
    this.motionBlur = new MotionBlurRenderer(device, SCENE_FORMAT);
    this.surfacePostEffects = new SurfacePostEffectsRenderer(device, format);
    this.layerEffects = new LayerEffectRenderer(device, SCENE_FORMAT);
  }
  destroy(): void {
    this.frameReadback.destroy();
    this.mediaTextures.destroy();
    this.materialTextures?.destroy();
    this.materialTextures = undefined;
    this.precompositionSurfaces.destroy();
    this.sceneGenerators.destroy();
    this.bufferVisualizer.destroy();
    this.depthEffects.destroy();
    this.motionBlur.destroy();
    this.surfacePostEffects.destroy();
    this.auxiliaryBuffers.destroy();
    this.layerEffects.destroy();
    this.gpuProfiler.destroy();
    this.sceneTexture?.destroy();
    this.sceneTexture = undefined;
    this.depthTexture?.destroy();
    this.depthTexture = undefined;
    this.shadowTexture.destroy();
    this.shapeBuffer.destroy();
    this.lightingBuffer.destroy();
    this.postUniformBuffer.destroy();
    this.effectProgramBuffer.destroy();
    this.identityLut.destroy();
    this.postBindGroup = undefined;
    this.motionBlurPostBindGroup = undefined;
  }

  createPostBindGroup(source: GPUTexture, label: string): GPUBindGroup {
    return this.device.createBindGroup({
      label: `HDR fused post-process resources · ${label}`,
      layout: this.postPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: this.postSampler },
        { binding: 2, resource: { buffer: this.postUniformBuffer } },
        { binding: 3, resource: { buffer: this.effectProgramBuffer } },
        { binding: 4, resource: this.identityLut.createView({ dimension: "3d" }) },
        { binding: 5, resource: this.lutSampler },
        { binding: 6, resource: source.createView() },
        { binding: 7, resource: source.createView() },
      ],
    });
  }

  resizeSceneTargets(
    width: number,
    height: number,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
  ): void {
    context.configure({
      device: this.device,
      format,
      alphaMode: "opaque",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.sceneTexture?.destroy();
    this.depthTexture?.destroy();
    this.sceneTexture = this.device.createTexture({
      label: "HDR scene target",
      size: [width, height],
      format: SCENE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    this.depthTexture = this.device.createTexture({
      label: "Composition depth target",
      size: [width, height],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.postBindGroup = this.createPostBindGroup(this.sceneTexture, "scene");
    this.motionBlurPostBindGroup = undefined;
    this.bufferVisualizer.setSource(this.sceneTexture);
    this.layerEffects.resize(width, height);
  }

  configureShadowMap(size: number): void {
    if (size === this.shadowMapSize) return;
    this.shadowTexture.destroy();
    this.shadowMapSize = size;
    this.shadowTexture = this.device.createTexture({
      label: `Scene shadow map · ${size}²`,
      size: [size, size],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.lightingBindGroup = this.device.createBindGroup({
      label: "Scene lighting resources",
      layout: this.lightingBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.lightingBuffer } },
        { binding: 1, resource: this.shadowTexture.createView() },
        { binding: 2, resource: this.shadowSampler },
      ],
    });
  }

  ensureShapeBuffer(requiredBytes: number): void {
    if (requiredBytes <= this.shapeBufferBytes) return;
    this.shapeBufferBytes = 2 ** Math.ceil(Math.log2(requiredBytes));
    this.shapeBuffer.destroy();
    this.shapeBuffer = this.device.createBuffer({
      label: "Dynamic layer geometry · grown",
      size: this.shapeBufferBytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    });
  }
}
