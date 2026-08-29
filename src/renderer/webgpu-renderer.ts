import { evaluateLayerSourceTime } from "../core/layer-time";
import { logger } from "../core/logger";
import { evaluateWorldTransform } from "../core/scene-evaluation";
import type {
  BlendMode,
  Composition,
  EnvironmentLighting,
  GpuDiagnostics,
  Project,
  RendererMetrics,
} from "../core/types";
import { AuxiliaryBufferRenderer } from "./auxiliary-buffer-renderer";
import { SceneBufferVisualizer } from "./buffer-visualizer";
import { bundledParticleDefinition } from "./bundled-particle-generator";
import { DepthEffectsRenderer } from "./depth-effects";
import { analyzeEffectFusion } from "./effect-fusion";
import { FLOATS_PER_EFFECT_OPERATION, MAX_EFFECT_OPERATIONS } from "./effect-program";
import {
  type FrameReadbackTicket,
  GpuFrameReadbackPool,
  type RawFramePixelFormat,
  type RawVideoFrame,
} from "./frame-readback";
import { FLOATS_PER_VERTEX, type GeometryBatch } from "./geometry";
import { planGpuMemory } from "./gpu-memory-budget";
import { GpuTimestampProfiler } from "./gpu-timestamp-profiler";
import { LayerEffectRenderer } from "./layer-effects";
import { createLutSampler, createLutTexture } from "./lut-texture";
import { MaterialTextureRenderer } from "./material-textures";
import { MediaTextureCache } from "./media-texture-cache";
import { precompileGpuPipelines } from "./pipeline-precompile";
import { buildPostProcessUniforms } from "./post-process";
import { PrecompositionSurfaceRenderer } from "./precomposition-surface-renderer";
import {
  type BufferVisualization,
  isDepthEffectVisualization,
  isSurfaceEffectVisualization,
  postRenderRoute,
  usesAuxiliarySurfaceData,
} from "./render-buffers";
import { planSceneRenderStack } from "./render-stack";
import { createPostPipeline } from "./runtime-pipelines";
import { SceneEvaluationCache } from "./scene-evaluation-cache";
import { type PreparedSceneGenerator, SceneGeneratorHost } from "./scene-generator-host";
import { buildSceneLighting, SCENE_LIGHTING_BYTES, shadowMapSize } from "./scene-lighting";
import {
  createImagePipelines,
  createShadowPipeline,
  createShapePipelines,
} from "./scene-pipelines";
import { validateShaderSources } from "./shader-validation";
import { SurfacePostEffectsRenderer, selectedRenderId } from "./surface-post-effects";

const MAX_SHAPE_VERTICES = 6 * 128;
const SCENE_FORMAT: GPUTextureFormat = "rgba16float";
const DEFAULT_SHADOW_MAP_SIZE = 1024;

export class WebGpuRenderer {
  readonly diagnostics: GpuDiagnostics;
  readonly #device: GPUDevice;
  readonly #context: GPUCanvasContext;
  readonly #format: GPUTextureFormat;
  readonly #lightingBindGroupLayout: GPUBindGroupLayout;
  readonly #lightingBuffer: GPUBuffer;
  #lightingBindGroup: GPUBindGroup;
  readonly #shadowBindGroup: GPUBindGroup;
  #shadowTexture: GPUTexture;
  readonly #shadowSampler: GPUSampler;
  readonly #shadowPipeline: GPURenderPipeline;
  readonly #shapePipelines: Record<BlendMode, GPURenderPipeline>;
  readonly #imageBindGroupLayout: GPUBindGroupLayout;
  readonly #imagePipelines: Record<BlendMode, GPURenderPipeline>;
  readonly #sceneGenerators: SceneGeneratorHost;
  readonly #postPipeline: GPURenderPipeline;
  readonly #bufferVisualizer: SceneBufferVisualizer;
  readonly #depthEffects: DepthEffectsRenderer;
  readonly #surfacePostEffects: SurfacePostEffectsRenderer;
  readonly #auxiliaryBuffers: AuxiliaryBufferRenderer;
  readonly #layerEffects: LayerEffectRenderer;
  #materialTextures?: MaterialTextureRenderer;
  #shapeBuffer: GPUBuffer;
  readonly #postSampler: GPUSampler;
  readonly #lutSampler: GPUSampler;
  readonly #identityLut: GPUTexture;
  readonly #imageSampler: GPUSampler;
  readonly #postUniformBuffer: GPUBuffer;
  readonly #effectProgramBuffer: GPUBuffer;
  readonly #gpuProfiler: GpuTimestampProfiler;
  readonly #frameReadback: GpuFrameReadbackPool;
  #pendingFrameReadback?: FrameReadbackTicket;
  #postBindGroup?: GPUBindGroup;
  #sceneTexture?: GPUTexture;
  #depthTexture?: GPUTexture;
  #width = 1;
  #height = 1;
  #shadowMapSize = DEFAULT_SHADOW_MAP_SIZE;
  #memoryBudgetMb?: number;
  #bufferVisualization: BufferVisualization = "beauty";
  readonly #reportedAdjustmentErrors = new Set<string>();
  #smoothedFrameMs = 16.67;
  #lastFrameStarted?: number;
  #shapeBufferBytes = MAX_SHAPE_VERTICES * FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT;
  readonly #invalidate: () => void;
  readonly #mediaTextures: MediaTextureCache;
  readonly #precompositionSurfaces: PrecompositionSurfaceRenderer;
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
    this.#frameReadback = new GpuFrameReadbackPool(device, format);
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
      size: [DEFAULT_SHADOW_MAP_SIZE, DEFAULT_SHADOW_MAP_SIZE],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#shadowSampler = device.createSampler({
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
        { binding: 2, resource: this.#shadowSampler },
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
    this.#shapeBuffer = device.createBuffer({
      label: "Dynamic layer geometry",
      size: this.#shapeBufferBytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    });
    this.#sceneGenerators = new SceneGeneratorHost(device, SCENE_FORMAT, [
      bundledParticleDefinition,
    ]);
    this.#auxiliaryBuffers = new AuxiliaryBufferRenderer(device, this.#imageBindGroupLayout);
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
    this.#mediaTextures = new MediaTextureCache(
      device,
      this.#imageBindGroupLayout,
      this.#imageSampler,
      invalidate,
    );
    this.#precompositionSurfaces = new PrecompositionSurfaceRenderer(device, {
      mediaTextures: this.#mediaTextures,
      mediaLayout: this.#imageBindGroupLayout,
      mediaSampler: this.#imageSampler,
      lightingLayout: this.#lightingBindGroupLayout,
      shapePipelines: this.#shapePipelines,
      imagePipelines: this.#imagePipelines,
      sceneGenerators: this.#sceneGenerators,
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
    this.#postPipeline = createPostPipeline(device, format);
    this.#bufferVisualizer = new SceneBufferVisualizer(device, format);
    this.#depthEffects = new DepthEffectsRenderer(device, format);
    this.#surfacePostEffects = new SurfacePostEffectsRenderer(device, format);
    this.#layerEffects = new LayerEffectRenderer(device, SCENE_FORMAT);
  }
  static async create(
    canvas: HTMLCanvasElement,
    invalidate: () => void = () => undefined,
  ): Promise<WebGpuRenderer> {
    logger.debug("webgpu", "initialization_started");
    if (!navigator.gpu) throw new Error("WebGPU is unavailable");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No high-performance GPU adapter was found");
    const timestampQueries = adapter.features.has("timestamp-query");
    const requiredFeatures: GPUFeatureName[] = timestampQueries ? ["timestamp-query"] : [];
    const device = await adapter.requestDevice({ requiredFeatures });
    device.addEventListener("uncapturederror", (event) => {
      logger.error(
        "webgpu",
        "uncaptured_error",
        new Error(event.error.message || "WebGPU validation failed"),
        { gpuErrorType: event.error.constructor.name },
      );
    });
    void device.lost.then((info) => {
      logger.warn("webgpu", "device_lost", { reason: info.reason, message: info.message });
    });
    const format = navigator.gpu.getPreferredCanvasFormat();
    const [, precompile] = await Promise.all([
      validateShaderSources(device),
      precompileGpuPipelines(device, format, [bundledParticleDefinition]),
    ]);
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
      pipelineCompileMs: precompile.durationMs,
      prewarmedPipelines: precompile.count,
    };
    device.pushErrorScope("validation");
    const renderer = new WebGpuRenderer(device, context, format, diagnostics, invalidate);
    const validationError = await device.popErrorScope();
    if (validationError)
      throw new Error(`WebGPU renderer validation failed: ${validationError.message}`);
    logger.info("webgpu", "initialized", {
      adapter: diagnostics.adapter,
      architecture: diagnostics.architecture,
      timestampQueries,
      maxTextureSize: diagnostics.maxTextureSize,
      prewarmedPipelines: diagnostics.prewarmedPipelines,
      pipelineCompileMs: diagnostics.pipelineCompileMs,
    });
    return renderer;
  }
  resize(width: number, height: number): void {
    this.#frameReadback.reset();
    this.#width = Math.max(1, Math.floor(width));
    this.#height = Math.max(1, Math.floor(height));
    this.#context.configure({
      device: this.#device,
      format: this.#format,
      alphaMode: "opaque",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.#sceneTexture?.destroy();
    this.#depthTexture?.destroy();
    this.#sceneTexture = this.#device.createTexture({
      label: "HDR scene target",
      size: [this.#width, this.#height],
      format: SCENE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
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
    this.#bufferVisualizer.setSource(this.#sceneTexture);
    this.#configureAuxiliaryBuffers();
    this.#layerEffects.resize(this.#width, this.#height);
  }
  get bufferVisualization(): BufferVisualization {
    return this.#bufferVisualization;
  }
  setBufferVisualization(mode: BufferVisualization): BufferVisualization {
    this.#bufferVisualization = mode;
    this.#configureAuxiliaryBuffers();
    return this.#bufferVisualization;
  }
  get exportPixelFormat(): RawFramePixelFormat {
    return this.#frameReadback.pixelFormat;
  }
  renderRawFrame(
    composition: Composition,
    time: number,
    project?: Project,
    synchronizeVideo = false,
  ): Promise<RawVideoFrame> {
    if (synchronizeVideo) {
      this.render(composition, time, false, project);
      return this.#mediaTextures
        .waitForVideoFrames()
        .then(() => this.#captureRawFrame(composition, time, project));
    }
    return this.#captureRawFrame(composition, time, project);
  }
  #captureRawFrame(
    composition: Composition,
    time: number,
    project?: Project,
  ): Promise<RawVideoFrame> {
    if (this.#pendingFrameReadback)
      return Promise.reject(new Error("A GPU frame readback is already being encoded"));
    const ticket = this.#frameReadback.reserve(this.#width, this.#height);
    this.#pendingFrameReadback = ticket;
    try {
      this.render(composition, time, false, project);
    } catch (error) {
      ticket.abort();
      throw error;
    } finally {
      this.#pendingFrameReadback = undefined;
    }
    return ticket.read();
  }
  render(
    composition: Composition,
    time: number,
    playing = false,
    project?: Project,
    selectedLayerId?: string,
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
    const renderStack = planSceneRenderStack(sceneLayers, geometry.batches);
    this.#sceneGenerators.beginFrame();
    const surfaceFrame = this.#precompositionSurfaces.prepare(
      project,
      sceneLayers,
      playing,
      this.#memoryBudgetMb,
    );
    this.diagnostics.precompositionSurfaceError =
      surfaceFrame.diagnostics.length > 0 ? surfaceFrame.diagnostics.join("; ") : undefined;
    const primaryLight = sceneLayers.find((scene) => scene.layer.kind === "light")?.layer.light;
    const cameraLayer = composition.layers.find((layer) => layer.kind === "camera");
    const cameraTransform = cameraLayer
      ? evaluateWorldTransform(cameraLayer, composition, time)
      : undefined;
    const cameraPosition = cameraTransform?.position;
    const camera = cameraTransform
      ? {
          transform: cameraTransform,
          settings: cameraLayer?.camera ?? {
            projection: "perspective" as const,
            fieldOfView: 50,
            orthographicSize: composition.height,
          },
        }
      : undefined;
    const shadowQuality = primaryLight?.shadowQuality ?? "medium";
    const sceneGenerators = sceneLayers
      .filter((scene) => this.#sceneGenerators.supports(scene))
      .map((scene) =>
        this.#sceneGenerators.prepare(
          scene,
          composition,
          this.#width,
          this.#height,
          this.#memoryBudgetMb,
          camera,
        ),
      )
      .filter((generator): generator is PreparedSceneGenerator => generator !== undefined);
    this.diagnostics.sceneGeneratorError =
      this.#sceneGenerators.diagnostics.length > 0
        ? this.#sceneGenerators.diagnostics.join("; ")
        : undefined;
    const generatorByInstance = new Map(
      sceneGenerators.map((generator) => [generator.instanceId, generator]),
    );
    this.#sceneGenerators.sweep();
    const memory = planGpuMemory({
      width: this.#width,
      height: this.#height,
      effectTextureBytes: this.#layerEffects.estimatedTextureBytes(),
      persistentBufferBytes:
        this.#sceneGenerators.estimatedBytes +
        this.#shapeBufferBytes +
        this.#auxiliaryBuffers.estimatedBytes +
        this.#mediaTextures.estimatedBytes +
        surfaceFrame.residentBytes +
        this.#surfacePostEffects.estimatedBytes +
        (this.#materialTextures?.estimatedBytes ?? 0),
      requestedShadowMapSize: shadowMapSize(shadowQuality),
      budgetMb: this.#memoryBudgetMb,
    });
    const shadowsEnabled =
      shadowQuality !== "off" && primaryLight?.kind !== "point" && memory.shadowMapSize > 1;
    this.#configureShadowMap(memory.shadowMapSize);
    this.#device.queue.writeBuffer(
      this.#lightingBuffer,
      0,
      buildSceneLighting(sceneLayers, composition, shadowsEnabled, cameraPosition),
    );
    if (geometry.data.length > 0) {
      this.#ensureShapeBuffer(geometry.data.byteLength);
      this.#device.queue.writeBuffer(this.#shapeBuffer, 0, geometry.data);
    }
    if (
      !this.#materialTextures &&
      ((composition.environment?.enabled &&
        geometry.batches.some((batch) => batch.layer.kind === "mesh")) ||
        geometry.batches.some((batch) => batch.layer.mesh?.materialTextures?.normal))
    )
      this.#materialTextures = new MaterialTextureRenderer(
        this.#device,
        SCENE_FORMAT,
        this.#lightingBindGroupLayout,
        this.#invalidate,
        (message) => {
          this.diagnostics.materialResourceError = message;
        },
      );
    this.#materialTextures?.prepare(composition, geometry.batches);
    for (const scene of sceneLayers) {
      if (scene.layer.kind === "text") {
        this.#mediaTextures.prepareText(
          scene.layer,
          scene.resourceInstanceId,
          evaluateLayerSourceTime(scene.layer, scene.localTime),
          composition.frameRate.numerator / composition.frameRate.denominator,
        );
      } else if (
        (scene.layer.kind === "image" || scene.layer.kind === "video") &&
        (scene.layer.asset?.dataUrl ?? scene.layer.asset?.runtimeUrl)
      )
        this.#mediaTextures.prepareMedia(
          scene.layer,
          scene.localTime,
          playing,
          scene.resourceInstanceId,
        );
    }
    this.#mediaTextures.sweep(
      new Set([
        ...sceneLayers
          .filter(
            (scene) =>
              scene.layer.kind === "text" ||
              ((scene.layer.kind === "image" || scene.layer.kind === "video") &&
                (scene.layer.asset?.dataUrl ?? scene.layer.asset?.runtimeUrl)),
          )
          .map((scene) => scene.resourceInstanceId),
        ...surfaceFrame.mediaInstanceIds,
      ]),
    );
    this.#device.queue.writeBuffer(
      this.#postUniformBuffer,
      0,
      buildPostProcessUniforms(this.#width, this.#height, time),
    );
    if (!this.#sceneTexture || !this.#postBindGroup) this.resize(this.#width, this.#height);
    const encoder = this.#device.createCommandEncoder({ label: "Aster frame render graph" });
    this.#mediaTextures.flush(encoder);
    this.#precompositionSurfaces.encode(encoder);
    const compute = encoder.beginComputePass({
      label: sceneGenerators.some((generator) => generator.lodApplied)
        ? "Scene generators · bounded LOD"
        : "Scene generators",
      timestampWrites: this.#gpuProfiler.writes(0, 1),
    });
    for (const generator of sceneGenerators)
      this.#sceneGenerators.encodeCompute(compute, generator);
    compute.end();
    if (shadowsEnabled) {
      const shadowPass = encoder.beginRenderPass({
        label: `Scene shadow-map depth · ${this.#shadowMapSize}²`,
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
    } else {
      const shadowMarker = encoder.beginComputePass({
        label: "Shadow raster disabled",
        timestampWrites: this.#gpuProfiler.writes(2, 3),
      });
      shadowMarker.end();
    }
    const sceneTexture = this.#sceneTexture;
    const sceneView = sceneTexture?.createView();
    const depthView = this.#depthTexture?.createView();
    if (!sceneTexture || !sceneView || !depthView || !this.#postBindGroup)
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
    let adjustmentEffectLayerCount = 0;
    let fusedEffectCount = 0;
    let fusionGroupCount = 0;
    let fusionBarrierCount = 0;
    const drawnGenerators = new Set<string>();
    const activeEffectInstances = new Set<string>();
    this.diagnostics.adjustmentLayerError = undefined;
    for (const item of renderStack) {
      if (item.kind === "adjustment") {
        const { layer } = item.scene;
        if (!layer.effects.some((effect) => effect.enabled)) continue;
        const fusion = analyzeEffectFusion(layer.effects);
        scenePass?.end();
        scenePass = undefined;
        try {
          const operationCount = this.#layerEffects.encodeAdjustment(
            encoder,
            sceneTexture,
            composition,
            layer,
            item.scene.instanceId,
            time,
          );
          if (operationCount > 0) {
            activeEffectInstances.add(item.scene.instanceId);
            adjustmentEffectLayerCount += 1;
            effectOperationCount += operationCount;
            fusedEffectCount += fusion.fusedEffectCount;
            fusionGroupCount += fusion.fusedGroupCount;
            fusionBarrierCount += fusion.barrierCount;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.diagnostics.adjustmentLayerError = message;
          const diagnosticKey = `${layer.id}:${message}`;
          if (!this.#reportedAdjustmentErrors.has(diagnosticKey)) {
            this.#reportedAdjustmentErrors.add(diagnosticKey);
            logger.warn("webgpu", "adjustment_layer_skipped", {
              layerId: layer.id,
              error: message,
            });
          }
        }
        continue;
      }
      if (item.kind === "generator") {
        const generator = generatorByInstance.get(item.scene.instanceId);
        if (!generator || drawnGenerators.has(generator.instanceId)) continue;
        const hasEffects = item.scene.layer.effects.some((effect) => effect.enabled);
        if (hasEffects) {
          const fusion = analyzeEffectFusion(item.scene.layer.effects);
          scenePass?.end();
          scenePass = undefined;
          activeEffectInstances.add(item.scene.instanceId);
          effectLayerCount += 1;
          effectOperationCount += this.#layerEffects.encode(
            encoder,
            sceneView,
            composition,
            item.scene.layer,
            item.scene.instanceId,
            time,
            (layerPass) => this.#sceneGenerators.draw(layerPass, generator),
          );
          fusedEffectCount += fusion.fusedEffectCount;
          fusionGroupCount += fusion.fusedGroupCount;
          fusionBarrierCount += fusion.barrierCount;
          drawnGenerators.add(generator.instanceId);
          continue;
        }
        if (!scenePass) {
          scenePass = encoder.beginRenderPass({
            label: "Linear HDR scene generator group",
            colorAttachments: [{ view: sceneView, loadOp: "load", storeOp: "store" }],
            depthStencilAttachment: {
              view: depthView,
              depthLoadOp: "load",
              depthStoreOp: "store",
            },
          });
          scenePassCount += 1;
        }
        this.#sceneGenerators.draw(scenePass, generator);
        drawnGenerators.add(generator.instanceId);
        continue;
      }
      const { batch } = item;
      const hasEffects = batch.layer.effects.some((effect) => effect.enabled);
      if (hasEffects) {
        const fusion = analyzeEffectFusion(batch.layer.effects);
        fusedEffectCount += fusion.fusedEffectCount;
        fusionGroupCount += fusion.fusedGroupCount;
        fusionBarrierCount += fusion.barrierCount;
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
          (layerPass) => this.#drawBatch(layerPass, batch, "normal", composition.environment),
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
        this.#drawBatch(scenePass, batch, batch.layer.blendMode, composition.environment);
      }
    }
    const generatorDrawCount = drawnGenerators.size;
    scenePass?.end();
    let auxiliaryFrameValid = !usesAuxiliarySurfaceData(this.#bufferVisualization);
    if (!auxiliaryFrameValid) {
      auxiliaryFrameValid = this.#auxiliaryBuffers.encode({
        encoder,
        vertexBuffer: this.#shapeBuffer,
        vertexCount: geometry.data.length / FLOATS_PER_VERTEX,
        timelineTime: time,
        frameRate: composition.frameRate.numerator / composition.frameRate.denominator,
        batches: geometry.batches,
        mediaBindGroup: (batch) =>
          this.#precompositionSurfaces.bindingFor(batch.instanceId) ??
          this.#mediaTextures.bindGroup(batch.resourceInstanceId),
        generators: sceneGenerators
          .map((generator) => this.#sceneGenerators.auxiliaryDraw(generator))
          .filter((draw) => draw !== undefined),
      });
    }
    this.#surfacePostEffects.setSelection(
      selectedRenderId(
        geometry.batches,
        selectedLayerId,
        sceneGenerators.map((generator) => generator.selectionId),
      ),
    );
    this.#surfacePostEffects.setMotionShutterScale(this.#auxiliaryBuffers.motionShutterScale);
    this.#layerEffects.sweep(activeEffectInstances);
    const sceneTimingEnd = encoder.beginRenderPass({
      label: "Composition timing marker",
      timestampWrites: this.#gpuProfiler.writes(undefined, 5),
      colorAttachments: [{ view: sceneView, loadOp: "load", storeOp: "store" }],
    });
    sceneTimingEnd.end();
    const outputTexture = this.#context.getCurrentTexture();
    const output = outputTexture.createView();
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
    const postRoute = postRenderRoute(this.#bufferVisualization, auxiliaryFrameValid);
    if (postRoute === "beauty") {
      postPass.setPipeline(this.#postPipeline);
      postPass.setBindGroup(0, this.#postBindGroup);
      postPass.draw(3);
    } else if (isDepthEffectVisualization(this.#bufferVisualization)) {
      this.#depthEffects.encode(postPass, this.#bufferVisualization);
    } else if (isSurfaceEffectVisualization(this.#bufferVisualization)) {
      this.#surfacePostEffects.encode(postPass, this.#bufferVisualization);
    } else if (this.#bufferVisualization === "beauty") {
      postPass.setPipeline(this.#postPipeline);
      postPass.setBindGroup(0, this.#postBindGroup);
      postPass.draw(3);
    } else this.#bufferVisualizer.encode(postPass, this.#bufferVisualization);
    postPass.end();
    this.#pendingFrameReadback?.encode(encoder, outputTexture);
    const collectTimestamps = this.#gpuProfiler.encodeReadback(encoder);
    this.#device.queue.submit([encoder.finish()]);
    if (collectTimestamps) this.#gpuProfiler.readback();
    const cpuMs = performance.now() - started;
    const sample = frameInterval > 100 ? 16.67 : Math.max(frameInterval, 0.1);
    this.#smoothedFrameMs = this.#smoothedFrameMs * 0.9 + sample * 0.1;
    const shadowDrawCalls = shadowsEnabled
      ? geometry.batches.filter((batch) => batch.layer.threeDimensional).length
      : 0;
    return {
      fps: Math.min(240, 1000 / this.#smoothedFrameMs),
      frameMs: this.#smoothedFrameMs,
      cpuMs,
      gpuMs: this.#gpuProfiler.totalMs(),
      drawCalls:
        1 +
        geometry.batches.length +
        surfaceFrame.surfaceCount +
        shadowDrawCalls +
        effectLayerCount * 2 +
        adjustmentEffectLayerCount +
        generatorDrawCount,
      passCount:
        3 +
        Number(shadowsEnabled) +
        scenePassCount +
        effectLayerCount * 3 +
        adjustmentEffectLayerCount +
        surfaceFrame.surfaceCount,
      dirtyNodes: (evaluation.cacheHit ? 0 : sceneLayers.length) + effectOperationCount,
      cacheHitRate: this.#evaluationCache.hitRate(),
      estimatedVramMb: memory.estimatedBytes / 1024 / 1024,
      transientTextureCount: 6 + surfaceFrame.residentTextureCount,
      memoryBudgetMb: memory.budgetMb,
      memoryPressure: memory.pressure,
      shadowMapSize: memory.shadowMapSize,
      fusedEffectCount,
      fusionGroupCount,
      fusionBarrierCount,
      temporalCacheMb: this.#evaluationCache.memoryBytes() / 1024 / 1024,
      passTimings: this.#gpuProfiler.passTimings(),
    };
  }
  async complete(): Promise<void> {
    await this.#device.queue.onSubmittedWorkDone();
  }
  setMemoryBudget(megabytes?: number): void {
    this.#memoryBudgetMb = megabytes;
    this.#configureAuxiliaryBuffers();
  }
  #configureAuxiliaryBuffers(): void {
    this.#bufferVisualization = this.#auxiliaryBuffers.configureVisualization(
      this.#bufferVisualizer,
      this.#bufferVisualization,
      this.#width,
      this.#height,
      this.#memoryBudgetMb,
    );
    this.#depthEffects.setSources(
      this.#width,
      this.#height,
      this.#sceneTexture,
      this.#auxiliaryBuffers.textures.get("worldPosition"),
    );
    this.#surfacePostEffects.setSources(
      this.#width,
      this.#height,
      this.#sceneTexture,
      this.#auxiliaryBuffers.textures.get("objectId"),
      this.#auxiliaryBuffers.textures.get("motionVector"),
    );
  }
  #configureShadowMap(size: number): void {
    if (size === this.#shadowMapSize) return;
    this.#shadowTexture.destroy();
    this.#shadowMapSize = size;
    this.#shadowTexture = this.#device.createTexture({
      label: `Scene shadow map · ${size}²`,
      size: [size, size],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#lightingBindGroup = this.#device.createBindGroup({
      label: "Scene lighting resources",
      layout: this.#lightingBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#lightingBuffer } },
        { binding: 1, resource: this.#shadowTexture.createView() },
        { binding: 2, resource: this.#shadowSampler },
      ],
    });
  }
  #drawBatch(
    pass: GPURenderPassEncoder,
    batch: GeometryBatch,
    blendMode: BlendMode = batch.layer.blendMode,
    environment?: EnvironmentLighting,
  ): void {
    const surface =
      batch.layer.kind === "precomposition"
        ? this.#precompositionSurfaces.bindingFor(batch.instanceId)
        : undefined;
    const media =
      batch.layer.kind === "image" || batch.layer.kind === "video" || batch.layer.kind === "text"
        ? this.#mediaTextures.bindGroup(batch.resourceInstanceId)
        : undefined;
    pass.setVertexBuffer(0, this.#shapeBuffer);
    if (surface) {
      pass.setPipeline(this.#precompositionSurfaces.pipelineFor(blendMode));
      pass.setBindGroup(0, surface);
      pass.draw(batch.vertexCount, 1, batch.firstVertex);
      return;
    }
    if (batch.layer.kind === "precomposition") return;
    const material = this.#materialTextures?.bindingFor(
      batch.layer,
      batch.resourceInstanceId,
      blendMode,
      environment,
    );
    if (material) {
      pass.setPipeline(material.pipeline);
      pass.setBindGroup(0, this.#lightingBindGroup);
      pass.setBindGroup(1, material.bindGroup);
    } else if (media) {
      pass.setPipeline(this.#imagePipelines[blendMode]);
      pass.setBindGroup(0, media);
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
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    });
  }
}
