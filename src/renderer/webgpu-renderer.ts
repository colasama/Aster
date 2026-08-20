import { evaluateLayerSourceTime } from "../core/layer-time";
import type {
  BlendMode,
  Composition,
  GpuDiagnostics,
  Layer,
  Project,
  RendererMetrics,
} from "../core/types";
import { FLOATS_PER_EFFECT_OPERATION, MAX_EFFECT_OPERATIONS } from "./effect-program";
import { FLOATS_PER_VERTEX, type GeometryBatch } from "./geometry";
import { GpuTimestampProfiler } from "./gpu-timestamp-profiler";
import { LayerEffectRenderer } from "./layer-effects";
import { createLutSampler, createLutTexture } from "./lut-texture";
import { buildPostProcessUniforms } from "./post-process";
import { SceneEvaluationCache } from "./scene-evaluation-cache";
import { buildSceneLighting, SCENE_LIGHTING_BYTES } from "./scene-lighting";
import {
  createImagePipelines,
  createShadowPipeline,
  createShapePipelines,
} from "./scene-pipelines";
import {
  imageShader,
  particleComputeShader,
  particleRenderShader,
  postProcessShader,
  shadowShader,
  shapeShader,
} from "./shaders";
import { rasterizeTextLayer } from "./text-rasterizer";

const PARTICLE_CAPACITY = 1_000_000;
const MAX_SHAPE_VERTICES = 6 * 128;
const SCENE_FORMAT: GPUTextureFormat = "rgba16float";
const SHADOW_MAP_SIZE = 1024;

interface MediaResource {
  source: string;
  kind: "image" | "video" | "text";
  texture?: GPUTexture;
  bindGroup?: GPUBindGroup;
  video?: HTMLVideoElement;
  videoCanvas?: HTMLCanvasElement;
  videoContext?: CanvasRenderingContext2D;
  lastUploadedTime?: number;
  uploadErrorReported?: boolean;
}

export class WebGpuRenderer {
  readonly diagnostics: GpuDiagnostics;
  readonly #device: GPUDevice;
  readonly #context: GPUCanvasContext;
  readonly #format: GPUTextureFormat;
  readonly #lightingBindGroupLayout: GPUBindGroupLayout;
  readonly #lightingBuffer: GPUBuffer;
  readonly #lightingBindGroup: GPUBindGroup;
  readonly #shadowBindGroup: GPUBindGroup;
  readonly #shadowTexture: GPUTexture;
  readonly #shadowPipeline: GPURenderPipeline;
  readonly #shapePipelines: Record<BlendMode, GPURenderPipeline>;
  readonly #imageBindGroupLayout: GPUBindGroupLayout;
  readonly #imagePipelines: Record<BlendMode, GPURenderPipeline>;
  readonly #particlePipeline: GPURenderPipeline;
  readonly #postPipeline: GPURenderPipeline;
  readonly #layerEffects: LayerEffectRenderer;
  readonly #computePipeline: GPUComputePipeline;
  #shapeBuffer: GPUBuffer;
  readonly #particleBuffer: GPUBuffer;
  readonly #particleIndirectBuffer: GPUBuffer;
  readonly #simulationBuffer: GPUBuffer;
  readonly #computeBindGroup: GPUBindGroup;
  readonly #particleBindGroup: GPUBindGroup;
  readonly #postSampler: GPUSampler;
  readonly #lutSampler: GPUSampler;
  readonly #identityLut: GPUTexture;
  readonly #imageSampler: GPUSampler;
  readonly #postUniformBuffer: GPUBuffer;
  readonly #effectProgramBuffer: GPUBuffer;
  readonly #gpuProfiler: GpuTimestampProfiler;
  #postBindGroup?: GPUBindGroup;
  #sceneTexture?: GPUTexture;
  #depthTexture?: GPUTexture;
  #width = 1;
  #height = 1;
  #smoothedFrameMs = 16.67;
  #lastFrameStarted?: number;
  #shapeBufferBytes = MAX_SHAPE_VERTICES * FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT;
  readonly #invalidate: () => void;
  readonly #mediaResources = new Map<string, MediaResource>();
  readonly #evaluationCache = new SceneEvaluationCache();

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    diagnostics: GpuDiagnostics,
    invalidate: () => void,
  ) {
    this.#device = device;
    this.#context = context;
    this.#format = format;
    this.diagnostics = diagnostics;
    this.#invalidate = invalidate;
    this.#gpuProfiler = new GpuTimestampProfiler(device, diagnostics.timestampQueries, invalidate);
    this.#lightingBindGroupLayout = device.createBindGroupLayout({
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
    this.#lightingBuffer = device.createBuffer({
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
    this.#shadowBindGroup = device.createBindGroup({
      label: "Shadow depth uniforms",
      layout: shadowBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.#lightingBuffer } }],
    });
    this.#shadowTexture = device.createTexture({
      label: "Scene shadow map · 1024²",
      size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const shadowSampler = device.createSampler({
      label: "Scene shadow comparison sampler",
      compare: "less-equal",
      minFilter: "linear",
      magFilter: "linear",
    });
    this.#lightingBindGroup = device.createBindGroup({
      label: "Scene lighting resources",
      layout: this.#lightingBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#lightingBuffer } },
        { binding: 1, resource: this.#shadowTexture.createView() },
        { binding: 2, resource: shadowSampler },
      ],
    });
    this.#shapePipelines = createShapePipelines(
      device,
      SCENE_FORMAT,
      this.#lightingBindGroupLayout,
    );
    this.#shadowPipeline = createShadowPipeline(device, shadowBindGroupLayout);
    this.#imageBindGroupLayout = device.createBindGroupLayout({
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
    this.#imagePipelines = createImagePipelines(device, SCENE_FORMAT, this.#imageBindGroupLayout);
    this.#particleBuffer = device.createBuffer({
      label: "GPU particle storage · 1M capacity",
      size: PARTICLE_CAPACITY * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.#particleIndirectBuffer = device.createBuffer({
      label: "GPU particle indirect draw arguments",
      size: 4 * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE,
    });
    this.#simulationBuffer = device.createBuffer({
      label: "Particle simulation uniforms",
      size: 20 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#shapeBuffer = device.createBuffer({
      label: "Dynamic layer geometry",
      size: this.#shapeBufferBytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const computeModule = device.createShaderModule({
      label: "Particle compute",
      code: particleComputeShader,
    });
    this.#computePipeline = device.createComputePipeline({
      label: "Time-addressable particle simulation",
      layout: "auto",
      compute: { module: computeModule, entryPoint: "compute_main" },
    });
    this.#computeBindGroup = device.createBindGroup({
      label: "Particle compute resources",
      layout: this.#computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.#simulationBuffer } },
        { binding: 1, resource: { buffer: this.#particleBuffer } },
        { binding: 2, resource: { buffer: this.#particleIndirectBuffer } },
      ],
    });
    this.#particlePipeline = this.#createParticlePipeline();
    this.#particleBindGroup = device.createBindGroup({
      label: "Particle render resources",
      layout: this.#particlePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.#particleBuffer } },
        { binding: 1, resource: { buffer: this.#simulationBuffer } },
      ],
    });
    this.#postSampler = device.createSampler({
      label: "HDR linear sampler",
      magFilter: "linear",
      minFilter: "linear",
    });
    this.#lutSampler = createLutSampler(device);
    this.#identityLut = createLutTexture(device);
    this.#imageSampler = device.createSampler({
      label: "Imported image sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
    });
    this.#postUniformBuffer = device.createBuffer({
      label: "Fused post-process uniforms",
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#effectProgramBuffer = device.createBuffer({
      label: "Compiled GPU effect program",
      size: MAX_EFFECT_OPERATIONS * FLOATS_PER_EFFECT_OPERATION * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.#postPipeline = this.#createPostPipeline();
    this.#layerEffects = new LayerEffectRenderer(device, SCENE_FORMAT);
  }

  static async create(
    canvas: HTMLCanvasElement,
    invalidate: () => void = () => undefined,
  ): Promise<WebGpuRenderer> {
    if (!navigator.gpu) throw new Error("WebGPU is unavailable");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No high-performance GPU adapter was found");
    const timestampQueries = adapter.features.has("timestamp-query");
    const requiredFeatures: GPUFeatureName[] = timestampQueries ? ["timestamp-query"] : [];
    const device = await adapter.requestDevice({ requiredFeatures });
    await validateShaderSources(device);
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("Unable to create a WebGPU canvas context");
    const info = adapter.info;
    const diagnostics: GpuDiagnostics = {
      available: true,
      adapter: info.device || info.description || "High-performance adapter",
      architecture: info.architecture || "native",
      description: `${info.vendor || "GPU"} · ${info.description || info.device || "WebGPU"}`,
      maxTextureSize: device.limits.maxTextureDimension2D,
      timestampQueries,
    };
    device.pushErrorScope("validation");
    const renderer = new WebGpuRenderer(
      device,
      context,
      navigator.gpu.getPreferredCanvasFormat(),
      diagnostics,
      invalidate,
    );
    const validationError = await device.popErrorScope();
    if (validationError)
      throw new Error(`WebGPU renderer validation failed: ${validationError.message}`);
    return renderer;
  }

  resize(width: number, height: number): void {
    this.#width = Math.max(1, Math.floor(width));
    this.#height = Math.max(1, Math.floor(height));
    this.#context.configure({
      device: this.#device,
      format: this.#format,
      alphaMode: "opaque",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.#sceneTexture?.destroy();
    this.#depthTexture?.destroy();
    this.#sceneTexture = this.#device.createTexture({
      label: "HDR scene target",
      size: [this.#width, this.#height],
      format: SCENE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#depthTexture = this.#device.createTexture({
      label: "Composition depth target",
      size: [this.#width, this.#height],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.#postBindGroup = this.#device.createBindGroup({
      label: "HDR fused post-process resources",
      layout: this.#postPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.#sceneTexture.createView() },
        { binding: 1, resource: this.#postSampler },
        { binding: 2, resource: { buffer: this.#postUniformBuffer } },
        { binding: 3, resource: { buffer: this.#effectProgramBuffer } },
        { binding: 4, resource: this.#identityLut.createView({ dimension: "3d" }) },
        { binding: 5, resource: this.#lutSampler },
      ],
    });
    this.#layerEffects.resize(this.#width, this.#height);
  }

  render(
    composition: Composition,
    time: number,
    playing = false,
    project?: Project,
  ): RendererMetrics {
    const started = performance.now();
    const frameInterval = this.#lastFrameStarted ? started - this.#lastFrameStarted : 16.67;
    this.#lastFrameStarted = started;
    const evaluation = this.#evaluationCache.evaluate(
      composition,
      project,
      time,
      this.#width,
      this.#height,
    );
    const { sceneLayers, geometry } = evaluation;
    const particleScene = sceneLayers.find((scene) => scene.layer.kind === "particle");
    const particleCount = Math.max(
      1,
      Math.min(PARTICLE_CAPACITY, Math.round(particleScene?.layer.particle?.count ?? 100_000)),
    );
    const particleSeed = particleScene?.layer.particle?.seed ?? 13_337;
    const particleSettings = particleScene?.layer.particle;
    const particleColor = particleScene?.layer.color ?? [0.5, 0.74, 1, 0.65];
    this.#device.queue.writeBuffer(
      this.#lightingBuffer,
      0,
      buildSceneLighting(sceneLayers, composition),
    );
    if (geometry.data.length > 0) {
      this.#ensureShapeBuffer(geometry.data.byteLength);
      this.#device.queue.writeBuffer(this.#shapeBuffer, 0, geometry.data);
    }
    for (const scene of sceneLayers) {
      if (scene.layer.kind === "text") {
        this.#prepareText(scene.layer, scene.instanceId);
      } else if (
        (scene.layer.kind === "image" || scene.layer.kind === "video") &&
        scene.layer.asset?.dataUrl
      )
        this.#prepareMedia(scene.layer, scene.localTime, playing, scene.instanceId);
    }
    this.#sweepMediaResources(
      new Set(
        sceneLayers
          .filter(
            (scene) =>
              scene.layer.kind === "text" ||
              ((scene.layer.kind === "image" || scene.layer.kind === "video") &&
                scene.layer.asset?.dataUrl),
          )
          .map((scene) => scene.instanceId),
      ),
    );
    this.#device.queue.writeBuffer(
      this.#simulationBuffer,
      0,
      new Float32Array([
        time,
        this.#width / this.#height,
        particleCount,
        particleSeed,
        particleSettings?.lifetime ?? 6,
        particleSettings?.speed ?? 0.16,
        particleSettings?.acceleration ?? -0.035,
        particleSettings?.startSize ?? 2.4,
        particleSettings?.endSize ?? 0.35,
        particleSettings?.startRotation ?? 0,
        particleSettings?.endRotation ?? 180,
        0,
        ...particleColor,
        particleColor[0] * 0.25 + 0.75,
        particleColor[1] * 0.25 + 0.75,
        particleColor[2] * 0.25 + 0.75,
        0,
      ]),
    );
    this.#device.queue.writeBuffer(
      this.#postUniformBuffer,
      0,
      buildPostProcessUniforms(this.#width, this.#height, time),
    );
    if (!this.#sceneTexture || !this.#postBindGroup) this.resize(this.#width, this.#height);
    const encoder = this.#device.createCommandEncoder({ label: "Aster frame render graph" });
    const compute = encoder.beginComputePass({
      label: "GPU particle simulation",
      timestampWrites: this.#gpuProfiler.writes(0, 1),
    });
    compute.setPipeline(this.#computePipeline);
    compute.setBindGroup(0, this.#computeBindGroup);
    if (particleScene) compute.dispatchWorkgroups(Math.ceil(particleCount / 256));
    compute.end();
    const shadowPass = encoder.beginRenderPass({
      label: "Scene shadow-map depth",
      timestampWrites: this.#gpuProfiler.writes(2, 3),
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.#shadowTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    shadowPass.setPipeline(this.#shadowPipeline);
    shadowPass.setBindGroup(0, this.#shadowBindGroup);
    shadowPass.setVertexBuffer(0, this.#shapeBuffer);
    for (const batch of geometry.batches) {
      if (!batch.layer.threeDimensional) continue;
      shadowPass.draw(batch.vertexCount, 1, batch.firstVertex);
    }
    shadowPass.end();
    const sceneView = this.#sceneTexture?.createView();
    const depthView = this.#depthTexture?.createView();
    if (!sceneView || !depthView || !this.#postBindGroup)
      throw new Error("HDR scene target is unavailable");
    let scenePass: GPURenderPassEncoder | undefined = encoder.beginRenderPass({
      label: "Linear HDR composition",
      timestampWrites: this.#gpuProfiler.writes(4),
      colorAttachments: [
        {
          view: sceneView,
          clearValue: {
            r: composition.background[0],
            g: composition.background[1],
            b: composition.background[2],
            a: composition.background[3],
          },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    let scenePassCount = 1;
    let effectOperationCount = 0;
    let effectLayerCount = 0;
    const activeEffectInstances = new Set<string>();
    if (geometry.data.length > 0) {
      for (const batch of geometry.batches) {
        const hasEffects = batch.layer.effects.some((effect) => effect.enabled);
        if (hasEffects) {
          scenePass?.end();
          scenePass = undefined;
          activeEffectInstances.add(batch.instanceId);
          effectLayerCount += 1;
          effectOperationCount += this.#layerEffects.encode(
            encoder,
            sceneView,
            composition,
            batch.layer,
            batch.instanceId,
            time,
            (layerPass) => this.#drawBatch(layerPass, batch, "normal"),
          );
        } else {
          if (!scenePass) {
            scenePass = encoder.beginRenderPass({
              label: "Linear HDR direct layer group",
              colorAttachments: [{ view: sceneView, loadOp: "load", storeOp: "store" }],
              depthStencilAttachment: {
                view: depthView,
                depthLoadOp: "load",
                depthStoreOp: "store",
              },
            });
            scenePassCount += 1;
          }
          this.#drawBatch(scenePass, batch);
        }
      }
    }
    const particleVisible = Boolean(particleScene);
    if (particleVisible) {
      if (!scenePass) {
        scenePass = encoder.beginRenderPass({
          label: "Linear HDR particle group",
          colorAttachments: [{ view: sceneView, loadOp: "load", storeOp: "store" }],
          depthStencilAttachment: {
            view: depthView,
            depthLoadOp: "load",
            depthStoreOp: "store",
          },
        });
        scenePassCount += 1;
      }
      scenePass.setPipeline(this.#particlePipeline);
      scenePass.setBindGroup(0, this.#particleBindGroup);
      scenePass.drawIndirect(this.#particleIndirectBuffer, 0);
    }
    scenePass?.end();
    this.#layerEffects.sweep(activeEffectInstances);
    const sceneTimingEnd = encoder.beginRenderPass({
      label: "Composition timing marker",
      timestampWrites: this.#gpuProfiler.writes(undefined, 5),
      colorAttachments: [{ view: sceneView, loadOp: "load", storeOp: "store" }],
    });
    sceneTimingEnd.end();
    const output = this.#context.getCurrentTexture().createView();
    const postPass = encoder.beginRenderPass({
      label: "Fused effects + ACES display transform",
      timestampWrites: this.#gpuProfiler.writes(6, 7),
      colorAttachments: [
        {
          view: output,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    postPass.setPipeline(this.#postPipeline);
    postPass.setBindGroup(0, this.#postBindGroup);
    postPass.draw(3);
    postPass.end();
    const collectTimestamps = this.#gpuProfiler.encodeReadback(encoder);
    this.#device.queue.submit([encoder.finish()]);
    if (collectTimestamps) this.#gpuProfiler.readback();
    const cpuMs = performance.now() - started;
    const sample = frameInterval > 100 ? 16.67 : Math.max(frameInterval, 0.1);
    this.#smoothedFrameMs = this.#smoothedFrameMs * 0.9 + sample * 0.1;
    const hdr4kBytes =
      composition.width * composition.height * 8 * 3 +
      this.#layerEffects.estimatedTextureBytes() +
      SHADOW_MAP_SIZE * SHADOW_MAP_SIZE * 4;
    const shadowDrawCalls = geometry.batches.filter((batch) => batch.layer.threeDimensional).length;
    return {
      fps: Math.min(240, 1000 / this.#smoothedFrameMs),
      frameMs: this.#smoothedFrameMs,
      cpuMs,
      gpuMs: this.#gpuProfiler.totalMs(),
      drawCalls:
        1 +
        geometry.batches.length +
        shadowDrawCalls +
        effectLayerCount * 2 +
        Number(particleVisible),
      passCount: 4 + scenePassCount + effectLayerCount * 3,
      dirtyNodes: (evaluation.cacheHit ? 0 : sceneLayers.length) + effectOperationCount,
      cacheHitRate: this.#evaluationCache.hitRate(),
      estimatedVramMb: (hdr4kBytes + PARTICLE_CAPACITY * 16) / 1024 / 1024,
      transientTextureCount: 6,
      passTimings: this.#gpuProfiler.passTimings(),
    };
  }

  async complete(): Promise<void> {
    await this.#device.queue.onSubmittedWorkDone();
  }

  #drawBatch(
    pass: GPURenderPassEncoder,
    batch: GeometryBatch,
    blendMode: BlendMode = batch.layer.blendMode,
  ): void {
    const media =
      batch.layer.kind === "image" || batch.layer.kind === "video" || batch.layer.kind === "text"
        ? this.#mediaResources.get(batch.instanceId)
        : undefined;
    pass.setVertexBuffer(0, this.#shapeBuffer);
    if (media?.bindGroup) {
      pass.setPipeline(this.#imagePipelines[blendMode]);
      pass.setBindGroup(0, media.bindGroup);
    } else {
      pass.setPipeline(this.#shapePipelines[blendMode]);
      pass.setBindGroup(0, this.#lightingBindGroup);
    }
    pass.draw(batch.vertexCount, 1, batch.firstVertex);
  }

  #ensureShapeBuffer(requiredBytes: number): void {
    if (requiredBytes <= this.#shapeBufferBytes) return;
    this.#shapeBufferBytes = 2 ** Math.ceil(Math.log2(requiredBytes));
    this.#shapeBuffer.destroy();
    this.#shapeBuffer = this.#device.createBuffer({
      label: "Dynamic layer geometry · grown",
      size: this.#shapeBufferBytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  #prepareMedia(layer: Layer, time: number, playing: boolean, instanceId: string): void {
    const source = layer.asset?.dataUrl;
    if (!source) return;
    const existing = this.#mediaResources.get(instanceId);
    if (existing?.source === source && existing.kind === layer.kind) {
      if (existing.kind === "video") this.#updateVideo(existing, layer, time, playing);
      return;
    }
    this.#destroyMediaResource(existing);
    const resource: MediaResource = { source, kind: layer.kind === "video" ? "video" : "image" };
    this.#mediaResources.set(instanceId, resource);
    if (resource.kind === "video") {
      this.#prepareVideo(resource, layer, time, playing, instanceId);
      return;
    }
    void fetch(source)
      .then((response) => response.blob())
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => {
        const texture = this.#device.createTexture({
          label: `Imported image · ${layer.asset?.name ?? layer.name}`,
          size: [bitmap.width, bitmap.height],
          format: "rgba8unorm-srgb",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.#device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [
          bitmap.width,
          bitmap.height,
        ]);
        bitmap.close();
        if (this.#mediaResources.get(instanceId) !== resource) {
          texture.destroy();
          return;
        }
        resource.texture = texture;
        resource.bindGroup = this.#device.createBindGroup({
          label: `Imported image resources · ${layer.id}`,
          layout: this.#imageBindGroupLayout,
          entries: [
            { binding: 0, resource: texture.createView() },
            { binding: 1, resource: this.#imageSampler },
          ],
        });
        this.#invalidate();
      })
      .catch(() => {
        if (this.#mediaResources.get(instanceId) === resource)
          this.#mediaResources.delete(instanceId);
      });
  }

  #prepareText(layer: Layer, instanceId: string): void {
    const source = JSON.stringify([
      layer.text,
      layer.name,
      layer.color,
      layer.size,
      layer.textStyle,
    ]);
    const existing = this.#mediaResources.get(instanceId);
    if (existing?.kind === "text" && existing.source === source) return;
    this.#destroyMediaResource(existing);
    const resource: MediaResource = { source, kind: "text" };
    this.#mediaResources.set(instanceId, resource);
    const raster = rasterizeTextLayer(
      layer,
      Math.min(4096, this.#device.limits.maxTextureDimension2D),
    );
    const texture = this.#device.createTexture({
      label: `GPU text cache · ${layer.name}`,
      size: [raster.width, raster.height],
      format: "rgba8unorm-srgb",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#device.queue.writeTexture(
      { texture },
      raster.pixels,
      { bytesPerRow: raster.width * 4, rowsPerImage: raster.height },
      [raster.width, raster.height],
    );
    resource.texture = texture;
    resource.bindGroup = this.#device.createBindGroup({
      label: `GPU text resources · ${layer.id}`,
      layout: this.#imageBindGroupLayout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this.#imageSampler },
      ],
    });
  }

  #prepareVideo(
    resource: MediaResource,
    layer: Layer,
    time: number,
    playing: boolean,
    instanceId: string,
  ): void {
    const video = document.createElement("video");
    video.preload = "auto";
    video.playsInline = true;
    video.muted = !layer.audioEnabled;
    video.dataset.asterLayerId = instanceId;
    video.dataset.decoderState = "loading";
    video.setAttribute("aria-hidden", "true");
    Object.assign(video.style, {
      height: "1px",
      left: "0",
      opacity: "0.001",
      pointerEvents: "none",
      position: "fixed",
      top: "0",
      width: "1px",
    });
    video.src = resource.source;
    resource.video = video;
    document.body.append(video);
    const prepareTexture = () => {
      if (this.#mediaResources.get(instanceId) !== resource || resource.texture) return;
      video.dataset.decoderState = "ready";
      const width = Math.max(1, video.videoWidth || layer.asset?.width || 1);
      const height = Math.max(1, video.videoHeight || layer.asset?.height || 1);
      resource.texture = this.#device.createTexture({
        label: `Hardware-decoded video · ${layer.asset?.name ?? layer.name}`,
        size: [width, height],
        format: "rgba8unorm-srgb",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      resource.videoCanvas = document.createElement("canvas");
      resource.videoCanvas.width = width;
      resource.videoCanvas.height = height;
      resource.videoCanvas.setAttribute("aria-hidden", "true");
      Object.assign(resource.videoCanvas.style, {
        height: "1px",
        left: "0",
        opacity: "0.001",
        pointerEvents: "none",
        position: "fixed",
        top: "1px",
        width: "1px",
      });
      document.body.append(resource.videoCanvas);
      resource.videoContext =
        resource.videoCanvas.getContext("2d", { alpha: false, willReadFrequently: true }) ??
        undefined;
      resource.bindGroup = this.#device.createBindGroup({
        label: `Video texture resources · ${layer.id}`,
        layout: this.#imageBindGroupLayout,
        entries: [
          { binding: 0, resource: resource.texture.createView() },
          { binding: 1, resource: this.#imageSampler },
        ],
      });
      this.#updateVideo(resource, layer, time, playing);
      this.#invalidate();
    };
    video.addEventListener("loadeddata", prepareTexture, { once: true });
    video.addEventListener("seeked", () => {
      video.dataset.decoderState = "seeked";
      this.#copyVideoFrame(resource);
      this.#invalidate();
    });
    video.addEventListener("error", () => {
      video.dataset.decoderState = "error";
      video.dataset.decoderError = video.error?.message ?? "decode failed";
      if (this.#mediaResources.get(instanceId) === resource) {
        this.#destroyMediaResource(resource);
        this.#mediaResources.delete(instanceId);
      }
    });
    video.load();
  }

  #updateVideo(resource: MediaResource, layer: Layer, time: number, playing: boolean): void {
    const video = resource.video;
    if (!video) return;
    video.muted = !layer.audioEnabled;
    const duration = Number.isFinite(video.duration)
      ? video.duration
      : (layer.asset?.duration ?? layer.outPoint - layer.inPoint);
    const mediaTime = evaluateLayerSourceTime(layer, time, Math.max(0, duration - 0.001));
    const tolerance = playing ? 0.12 : 1 / 240;
    if (Math.abs(video.currentTime - mediaTime) > tolerance) video.currentTime = mediaTime;
    if (playing && video.paused) {
      void video.play().catch(() => undefined);
    } else if (!playing && !video.paused) {
      video.pause();
    }
    this.#copyVideoFrame(resource);
  }

  #copyVideoFrame(resource: MediaResource): void {
    const video = resource.video;
    const texture = resource.texture;
    if (
      !video ||
      !texture ||
      !resource.videoCanvas ||
      !resource.videoContext ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      resource.lastUploadedTime === video.currentTime
    )
      return;
    const mediaTime = video.currentTime;
    try {
      resource.videoContext.drawImage(
        video,
        0,
        0,
        resource.videoCanvas.width,
        resource.videoCanvas.height,
      );
      const pixels = resource.videoContext.getImageData(
        0,
        0,
        resource.videoCanvas.width,
        resource.videoCanvas.height,
      );
      this.#device.queue.writeTexture(
        { texture },
        pixels.data,
        {
          bytesPerRow: resource.videoCanvas.width * 4,
          rowsPerImage: resource.videoCanvas.height,
        },
        [resource.videoCanvas.width, resource.videoCanvas.height],
      );
      resource.lastUploadedTime = mediaTime;
      resource.uploadErrorReported = false;
      video.dataset.gpuFrame = "uploaded";
      delete video.dataset.gpuError;
    } catch (error) {
      // A seek can temporarily make a hardware-decoded frame unavailable.
      this.#reportVideoUploadError(resource, error);
    }
  }

  #reportVideoUploadError(resource: MediaResource, error: unknown): void {
    if (resource.uploadErrorReported) return;
    resource.uploadErrorReported = true;
    if (resource.video)
      resource.video.dataset.gpuError = error instanceof Error ? error.message : String(error);
    console.warn("Aster video frame upload is waiting for a decoded frame", error);
  }

  #destroyMediaResource(resource?: MediaResource): void {
    if (!resource) return;
    resource.video?.pause();
    resource.videoCanvas?.remove();
    if (resource.video) {
      resource.video.removeAttribute("src");
      resource.video.load();
      resource.video.remove();
    }
    resource.texture?.destroy();
  }

  #sweepMediaResources(activeLayerIds: Set<string>): void {
    for (const [layerId, resource] of this.#mediaResources) {
      if (activeLayerIds.has(layerId)) continue;
      this.#destroyMediaResource(resource);
      this.#mediaResources.delete(layerId);
    }
  }

  #createParticlePipeline(): GPURenderPipeline {
    const module = this.#device.createShaderModule({
      label: "Particle billboard shader",
      code: particleRenderShader,
    });
    return this.#device.createRenderPipeline({
      label: "100K additive particle renderer",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: {
        module,
        entryPoint: "fragment_main",
        targets: [
          {
            format: SCENE_FORMAT,
            blend: {
              color: { srcFactor: "one", dstFactor: "one", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: false,
        depthCompare: "always",
      },
    });
  }

  #createPostPipeline(): GPURenderPipeline {
    const module = this.#device.createShaderModule({
      label: "HDR fused effects and display shader",
      code: postProcessShader,
    });
    return this.#device.createRenderPipeline({
      label: "HDR post-process and ACES output",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: {
        module,
        entryPoint: "fragment_main",
        targets: [{ format: this.#format }],
      },
      primitive: { topology: "triangle-list" },
    });
  }
}

async function validateShaderSources(device: GPUDevice): Promise<void> {
  const sources = [
    ["shape", shapeShader],
    ["image", imageShader],
    ["particle compute", particleComputeShader],
    ["particle render", particleRenderShader],
    ["shadow", shadowShader],
    ["post process", postProcessShader],
  ] as const;
  for (const [label, code] of sources) {
    const module = device.createShaderModule({ label: `Validate ${label}`, code });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter((message) => message.type === "error");
    if (errors.length > 0) {
      const details = errors
        .slice(0, 8)
        .map((message) => `${message.lineNum}:${message.linePos} ${message.message}`)
        .join("\n");
      throw new Error(`WebGPU ${label} shader compilation failed:\n${details}`);
    }
  }
}
