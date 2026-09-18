import { evaluateLayerSourceTime } from "../core/animation/layer-time";
import {
  compositionMotionBlurSettings,
  layerMotionBlurEnabled,
  layerSupportsMotionBlur,
  motionBlurInterval,
} from "../core/animation/motion-blur";
import { logger } from "../core/logger";
import { sourceForLayer, sourceLocator } from "../core/media/footage-source";
import { evaluateCameraBasis } from "../core/scene/camera-rig";
import type { Composition, GpuDiagnostics, Project, RendererMetrics } from "../core/types";
import { needsLayerIsolation } from "./compositing/layer-composite";
import { planSceneRenderStack } from "./compositing/render-stack";
import { transparencyGroups } from "./compositing/transparency-groups";
import { depthEffectSettingsFromCameraOptics } from "./effects/depth-effects";
import { analyzeEffectFusion } from "./effects/effect-fusion";
import { buildPostProcessUniforms } from "./effects/post-process";
import { selectedRenderId } from "./effects/surface-post-effects";
import { buildSceneGeometry, FLOATS_PER_VERTEX } from "./geometry/geometry";
import { productionDepthOfFieldAllocationError } from "./gpu/auxiliary-buffer-budget";
import {
  releaseFailedWebGpuInitialization,
  shouldReportGpuDeviceLoss,
} from "./gpu/device-lifecycle";
import { captureAfterExactFrameResources } from "./gpu/exact-frame-resource-barrier";
import { frameCadenceSample } from "./gpu/frame-cadence";
import type { FrameReadbackTicket, RawFramePixelFormat, RawVideoFrame } from "./gpu/frame-readback";
import { planGpuMemory } from "./gpu/gpu-memory-budget";
import { precompileGpuPipelines } from "./gpu/pipeline-precompile";
import {
  type BufferVisualization,
  isDepthEffectVisualization,
  isSurfaceEffectVisualization,
  postRenderRoute,
  usesAuxiliarySurfaceData,
} from "./gpu/render-buffers";
import { validateShaderSources } from "./gpu/shader-validation";
import { MaterialTextureRenderer } from "./media/material-textures";
import { RendererResources } from "./renderer-resources";
import { bundledParticleDefinition } from "./scene/bundled-particle-generator";
import { drawSceneBatch } from "./scene/draw-scene-batch";
import { evaluateSceneCamera } from "./scene/scene-camera";
import { SceneEvaluationCache } from "./scene/scene-evaluation-cache";
import type { PreparedSceneGenerator } from "./scene/scene-generator-host";
import { buildSceneLighting, shadowMapSize } from "./scene/scene-lighting";
import { buildTimeAddressedMotionVectors } from "./scene/time-addressed-motion-vectors";
import { planTextMotionBlurFrame } from "./text/text-motion-blur-plan";
import { transformedTextRasterScale } from "./text/text-rasterizer";

const SCENE_FORMAT: GPUTextureFormat = "rgba16float";

export class WebGpuRenderer {
  readonly #resources: RendererResources;
  readonly diagnostics: GpuDiagnostics;
  readonly #device: GPUDevice;
  readonly #context: GPUCanvasContext;
  readonly #format: GPUTextureFormat;
  #pendingFrameReadback?: FrameReadbackTicket;
  #width = 1;
  #height = 1;
  #memoryBudgetMb?: number;
  #exportTexture?: GPUTexture;
  #bufferVisualization: BufferVisualization = "beauty";
  #beautyDepthOfFieldActive = false;
  #beautyMotionBlurActive = false;
  #depthEffectsUseMotionBlur = false;
  readonly #reportedAdjustmentErrors = new Set<string>();
  #smoothedFrameMs = 16.67;
  #lastFrameStarted?: number;
  #lastFramePlaying = false;
  readonly #invalidate: () => void;
  readonly #evaluationCache = new SceneEvaluationCache();
  #disposed = false;
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
    this.#resources = new RendererResources(device, format, diagnostics, invalidate);
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
    let renderer: WebGpuRenderer | undefined;
    let initializationAborted = false;
    void device.lost.then((info) => {
      if (!shouldReportGpuDeviceLoss(renderer ? renderer.#disposed : false, initializationAborted))
        return;
      logger.warn("webgpu", "device_lost", { reason: info.reason, message: info.message });
    });
    try {
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
      renderer = new WebGpuRenderer(device, context, format, diagnostics, invalidate);
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
    } catch (error) {
      initializationAborted = true;
      try {
        releaseFailedWebGpuInitialization(renderer, device);
      } catch (cleanupError) {
        logger.warn("webgpu", "initialization_cleanup_failed", {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      throw error;
    }
  }
  resize(width: number, height: number): void {
    this.#assertActive();
    this.#resources.frameReadback.reset();
    this.#exportTexture?.destroy();
    this.#exportTexture = undefined;
    this.#width = Math.max(1, Math.floor(width));
    this.#height = Math.max(1, Math.floor(height));
    this.#context.configure({
      device: this.#device,
      format: this.#format,
      alphaMode: "premultiplied",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.#resources.sceneTexture?.destroy();
    this.#resources.depthTexture?.destroy();
    this.#resources.sceneTexture = this.#device.createTexture({
      label: "HDR scene target",
      size: [this.#width, this.#height],
      format: SCENE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    this.#resources.depthTexture = this.#device.createTexture({
      label: "Composition depth target",
      size: [this.#width, this.#height],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.#resources.postBindGroup = this.#resources.createPostBindGroup(
      this.#resources.sceneTexture,
      "scene",
    );
    this.#resources.motionBlurPostBindGroup = undefined;
    this.#resources.bufferVisualizer.setSource(this.#resources.sceneTexture);
    this.#configureAuxiliaryBuffers();
    this.#resources.layerEffects.resize(this.#width, this.#height);
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
    return this.#resources.frameReadback.pixelFormat;
  }
  get outputWidth(): number {
    return this.#width;
  }
  get outputHeight(): number {
    return this.#height;
  }
  get productionRenderError(): string | undefined {
    return productionDepthOfFieldAllocationError(
      this.#beautyDepthOfFieldActive,
      this.#resources.auxiliaryBuffers.depthOfFieldTier,
      this.#resources.auxiliaryBuffers.depthOfFieldDiagnostic,
    );
  }
  async renderRawFrame(
    composition: Composition,
    time: number,
    project?: Project,
    synchronizeVideo = false,
  ): Promise<RawVideoFrame> {
    this.#assertActive();
    if (synchronizeVideo) {
      this.render(composition, time, false, project);
      await Promise.all([
        this.#resources.mediaTextures.waitForFrameResources(),
        this.#resources.precompositionSurfaces.waitForResources(),
        this.#resources.materialTextures?.waitForResources(),
      ]);
      return this.#captureRawFrame(composition, time, project);
    }
    const resources = this.#resources;
    return captureAfterExactFrameResources(
      () => this.#captureRawFrame(composition, time, project),
      {
        get hasPendingFrameResources() {
          return (
            resources.mediaTextures.hasPendingFrameResources ||
            resources.precompositionSurfaces.hasPendingResources ||
            Boolean(resources.materialTextures?.hasPendingResources)
          );
        },
        async waitForFrameResources() {
          await Promise.all([
            resources.mediaTextures.waitForFrameResources(),
            resources.precompositionSurfaces.waitForResources(),
            resources.materialTextures?.waitForResources(),
          ]);
        },
      },
    );
  }
  #captureRawFrame(
    composition: Composition,
    time: number,
    project?: Project,
  ): Promise<RawVideoFrame> {
    if (this.#pendingFrameReadback)
      return Promise.reject(new Error("A GPU frame readback is already being encoded"));
    const ticket = this.#resources.frameReadback.reserve(this.#width, this.#height);
    this.#pendingFrameReadback = ticket;
    try {
      this.render(composition, time, false, project);
      const productionError = this.productionRenderError;
      if (productionError) throw new Error(productionError);
    } catch (error) {
      ticket.abort();
      throw error;
    } finally {
      this.#pendingFrameReadback = undefined;
    }
    return Promise.all([ticket.read(), this.#resources.transparency.complete()]).then(
      ([frame]) => frame,
    );
  }
  render(
    composition: Composition,
    time: number,
    playing = false,
    project?: Project,
    selectedLayerId?: string,
  ): RendererMetrics {
    try {
      return this.#renderFrame(composition, time, playing, project, selectedLayerId);
    } catch (error) {
      this.#resources.mediaTextures.abortFrame();
      throw error;
    }
  }
  #renderFrame(
    composition: Composition,
    time: number,
    playing = false,
    project?: Project,
    selectedLayerId?: string,
  ): RendererMetrics {
    const resources = this.#resources;
    this.#assertActive();
    const started = performance.now();
    const frameInterval = this.#lastFrameStarted ? started - this.#lastFrameStarted : 16.67;
    const continuousPlayback = playing && this.#lastFramePlaying;
    this.#lastFramePlaying = playing;
    this.#lastFrameStarted = started;
    const evaluation = this.#evaluationCache.evaluate(
      composition,
      project,
      time,
      this.#width,
      this.#height,
    );
    resources.mediaTextures.beginFrame();
    const motionBlurSettings = compositionMotionBlurSettings(composition);
    const previewResolutionScale = Math.max(
      this.#width / Math.max(1, composition.width),
      this.#height / Math.max(1, composition.height),
    );
    const textMotionBlurRequested =
      this.#bufferVisualization === "beauty" &&
      motionBlurSettings.enabled &&
      motionBlurSettings.shutterAngle > 0;
    const textMotionBlur = textMotionBlurRequested
      ? planTextMotionBlurFrame({
          composition,
          project,
          frameTime: time,
          sceneLayers: evaluation.sceneLayers,
          resolutionScale: previewResolutionScale,
        })
      : {
          sampleCount: 0,
          plans: new Map(),
          exposureSceneLayers: [],
          renderSceneLayers: evaluation.sceneLayers,
        };
    const camera = evaluateSceneCamera(composition, time);
    const sceneLayers =
      textMotionBlur.exposureSceneLayers.length > 0
        ? [...textMotionBlur.renderSceneLayers]
        : evaluation.sceneLayers;
    const geometry =
      textMotionBlur.exposureSceneLayers.length > 0
        ? buildSceneGeometry(composition, [...sceneLayers], camera)
        : evaluation.geometry;
    const renderStack = planSceneRenderStack(sceneLayers, geometry.batches);
    const motionBlurSelectionIds = new Set(
      geometry.batches
        .filter(
          (batch) => layerMotionBlurEnabled(batch.layer) && layerSupportsMotionBlur(batch.layer),
        )
        .map((batch) => batch.selectionId),
    );
    const beautyMotionBlur =
      this.#bufferVisualization === "beauty" &&
      motionBlurSettings.enabled &&
      motionBlurSettings.shutterAngle > 0 &&
      motionBlurSelectionIds.size > 0;
    const motionBlurRequested =
      motionBlurSettings.enabled &&
      motionBlurSettings.shutterAngle > 0 &&
      motionBlurSelectionIds.size > 0 &&
      (beautyMotionBlur ||
        this.#bufferVisualization === "motionVector" ||
        this.#bufferVisualization === "vectorMotionBlur");
    resources.sceneGenerators.beginFrame();
    const surfaceFrame = resources.precompositionSurfaces.prepare(
      project,
      sceneLayers,
      playing,
      this.#memoryBudgetMb,
      this.#bufferVisualization === "beauty",
    );
    this.diagnostics.precompositionSurfaceError =
      surfaceFrame.diagnostics.length > 0 ? surfaceFrame.diagnostics.join("; ") : undefined;
    const primaryLight = sceneLayers.find((scene) => scene.layer.kind === "light")?.layer.light;
    const cameraPosition = camera?.pose.position;
    const beautyDepthOfField =
      this.#bufferVisualization === "beauty" &&
      camera?.optics.depthOfField === true &&
      camera.projection.kind === "perspective";
    let auxiliaryConfigurationChanged = false;
    if (beautyDepthOfField !== this.#beautyDepthOfFieldActive) {
      this.#beautyDepthOfFieldActive = beautyDepthOfField;
      auxiliaryConfigurationChanged = true;
    }
    if (beautyMotionBlur !== this.#beautyMotionBlurActive) {
      this.#beautyMotionBlurActive = beautyMotionBlur;
      auxiliaryConfigurationChanged = true;
    }
    if (auxiliaryConfigurationChanged) this.#configureAuxiliaryBuffers();
    const frameRate = composition.frameRate.numerator / composition.frameRate.denominator;
    const shutterInterval = motionBlurInterval(time, frameRate, motionBlurSettings);
    let motionVectors: Float32Array | undefined;
    if (motionBlurRequested) {
      const shutterOpen = this.#evaluationCache.evaluate(
        composition,
        project,
        shutterInterval.openTime,
        this.#width,
        this.#height,
      );
      const shutterClose = this.#evaluationCache.evaluate(
        composition,
        project,
        shutterInterval.closeTime,
        this.#width,
        this.#height,
      );
      motionVectors = buildTimeAddressedMotionVectors(
        geometry,
        shutterOpen.geometry,
        shutterClose.geometry,
        motionBlurSelectionIds,
      );
    }
    if (camera) {
      const basis = evaluateCameraBasis(camera.pose);
      resources.depthEffects.setSettings({
        cameraPosition: camera.pose.position,
        cameraForward: basis.forward,
        ...depthEffectSettingsFromCameraOptics(camera.optics, composition.width, this.#width),
        transparencyTier: resources.auxiliaryBuffers.depthOfFieldTier,
      });
    }
    const shadowQuality = primaryLight?.shadowQuality ?? "medium";
    const sceneGenerators = sceneLayers
      .filter((scene) => resources.sceneGenerators.supports(scene))
      .map((scene) =>
        resources.sceneGenerators.prepare(
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
      resources.sceneGenerators.diagnostics.length > 0
        ? resources.sceneGenerators.diagnostics.join("; ")
        : undefined;
    const generatorByInstance = new Map(
      sceneGenerators.map((generator) => [generator.instanceId, generator]),
    );
    resources.sceneGenerators.sweep();
    const memory = planGpuMemory({
      width: this.#width,
      height: this.#height,
      effectTextureBytes: resources.layerEffects.estimatedTextureBytes(),
      persistentBufferBytes:
        resources.transparency.estimatedBytes +
        resources.sceneGenerators.estimatedBytes +
        resources.shapeBufferBytes +
        resources.auxiliaryBuffers.estimatedBytes +
        resources.motionBlur.estimatedBytes +
        resources.mediaTextures.estimatedBytes +
        surfaceFrame.residentBytes +
        resources.surfacePostEffects.estimatedBytes +
        (resources.materialTextures?.estimatedBytes ?? 0),
      requestedShadowMapSize: shadowMapSize(shadowQuality),
      budgetMb: this.#memoryBudgetMb,
    });
    const shadowsEnabled =
      shadowQuality !== "off" && primaryLight?.kind !== "point" && memory.shadowMapSize > 1;
    resources.configureShadowMap(memory.shadowMapSize);
    this.#device.queue.writeBuffer(
      resources.lightingBuffer,
      0,
      buildSceneLighting(sceneLayers, composition, shadowsEnabled, cameraPosition),
    );
    if (geometry.data.length > 0) {
      resources.ensureShapeBuffer(geometry.data.byteLength);
      this.#device.queue.writeBuffer(resources.shapeBuffer, 0, geometry.data);
    }
    if (
      !resources.materialTextures &&
      ((composition.environment?.enabled &&
        geometry.batches.some((batch) => batch.layer.kind === "mesh")) ||
        geometry.batches.some((batch) => batch.layer.mesh?.materialTextures?.normal))
    )
      resources.materialTextures = new MaterialTextureRenderer(
        this.#device,
        SCENE_FORMAT,
        resources.lightingBindGroupLayout,
        this.#invalidate,
        (message) => {
          this.diagnostics.materialResourceError = message;
        },
      );
    resources.materialTextures?.prepare(composition, geometry.batches);
    for (const scene of sceneLayers) {
      if (scene.layer.kind === "text") {
        resources.mediaTextures.prepareText(
          scene.layer,
          scene.resourceInstanceId,
          evaluateLayerSourceTime(scene.layer, scene.localTime),
          composition.frameRate.numerator / composition.frameRate.denominator,
          transformedTextRasterScale(previewResolutionScale, scene.transform.scale),
          textMotionBlur.plans.get(scene.resourceInstanceId),
        );
      } else if (
        (scene.layer.kind === "image" || scene.layer.kind === "video") &&
        sourceLocator(sourceForLayer(project, scene.layer))
      ) {
        const footage = sourceForLayer(project, scene.layer);
        if (!footage) continue;
        resources.mediaTextures.prepareMedia(
          scene.layer,
          footage,
          scene.localTime,
          playing,
          scene.resourceInstanceId,
          previewResolutionScale,
        );
      }
    }
    resources.mediaTextures.sweep(
      new Set([
        ...sceneLayers
          .filter(
            (scene) =>
              scene.layer.kind === "text" ||
              ((scene.layer.kind === "image" || scene.layer.kind === "video") &&
                Boolean(sourceLocator(sourceForLayer(project, scene.layer)))),
          )
          .map((scene) => scene.resourceInstanceId),
        ...surfaceFrame.mediaInstanceIds,
      ]),
    );
    this.#device.queue.writeBuffer(
      resources.postUniformBuffer,
      0,
      buildPostProcessUniforms(this.#width, this.#height, time),
    );
    if (!resources.sceneTexture || !resources.postBindGroup) this.resize(this.#width, this.#height);
    const encoder = this.#device.createCommandEncoder({ label: "Aster frame render graph" });
    resources.transparency.beginFrame(encoder);
    resources.mediaTextures.flush(encoder);
    resources.precompositionSurfaces.encode(encoder);
    const compute = encoder.beginComputePass({
      label: sceneGenerators.some((generator) => generator.lodApplied)
        ? "Scene generators · bounded LOD"
        : "Scene generators",
      timestampWrites: resources.gpuProfiler.writes(0, 1),
    });
    for (const generator of sceneGenerators)
      resources.sceneGenerators.encodeCompute(compute, generator);
    compute.end();
    if (shadowsEnabled) {
      const shadowPass = encoder.beginRenderPass({
        label: `Scene shadow-map depth · ${resources.shadowMapSize}²`,
        timestampWrites: resources.gpuProfiler.writes(2, 3),
        colorAttachments: [],
        depthStencilAttachment: {
          view: resources.shadowTexture.createView(),
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      shadowPass.setPipeline(resources.shadowPipeline);
      shadowPass.setBindGroup(0, resources.shadowBindGroup);
      shadowPass.setVertexBuffer(0, resources.shapeBuffer);
      for (const batch of geometry.batches) {
        if (!batch.layer.threeDimensional) continue;
        shadowPass.draw(batch.vertexCount, 1, batch.firstVertex);
      }
      shadowPass.end();
    } else {
      const shadowMarker = encoder.beginComputePass({
        label: "Shadow raster disabled",
        timestampWrites: resources.gpuProfiler.writes(2, 3),
      });
      shadowMarker.end();
    }
    const sceneTexture = resources.sceneTexture;
    const sceneView = sceneTexture?.createView();
    const depthView = resources.depthTexture?.createView();
    if (!sceneTexture || !sceneView || !depthView || !resources.postBindGroup)
      throw new Error("HDR scene target is unavailable");
    let scenePass: GPURenderPassEncoder | undefined = encoder.beginRenderPass({
      label: "Linear HDR composition",
      timestampWrites: resources.gpuProfiler.writes(4),
      colorAttachments: [
        {
          view: sceneView,
          clearValue: {
            r: 0,
            g: 0,
            b: 0,
            a: 0,
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
    let clearSceneDepth = false;
    this.diagnostics.adjustmentLayerError = undefined;
    const transparentGroups = transparencyGroups(renderStack);
    const captured = new Set<string>();
    for (const item of renderStack) {
      if (item.kind === "geometry" && captured.has(item.batch.instanceId)) continue;
      if (item.clearDepth) {
        scenePass?.end();
        scenePass = undefined;
        clearSceneDepth = true;
      }
      if (item.kind === "adjustment") {
        const { layer } = item.scene;
        if (!layer.effects.some((effect) => effect.enabled)) continue;
        const fusion = analyzeEffectFusion(layer.effects);
        scenePass?.end();
        scenePass = undefined;
        try {
          const operationCount = resources.layerEffects.encodeAdjustment(
            encoder,
            sceneTexture,
            composition,
            layer,
            item.scene.instanceId,
            item.scene.localTime,
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
        const hasEffects = needsLayerIsolation(item.scene.layer);
        if (hasEffects) {
          const fusion = analyzeEffectFusion(item.scene.layer.effects);
          scenePass?.end();
          scenePass = undefined;
          activeEffectInstances.add(item.scene.instanceId);
          effectLayerCount += 1;
          effectOperationCount += resources.layerEffects.encode(
            encoder,
            sceneTexture,
            composition,
            item.scene.layer,
            item.scene.instanceId,
            item.scene.localTime,
            (layerPass) => resources.sceneGenerators.draw(layerPass, generator, "normal"),
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
              depthClearValue: 1,
              depthLoadOp: clearSceneDepth ? "clear" : "load",
              depthStoreOp: "store",
            },
          });
          scenePassCount += 1;
          clearSceneDepth = false;
        }
        resources.sceneGenerators.draw(scenePass, generator);
        drawnGenerators.add(generator.instanceId);
        continue;
      }
      const { batch } = item;
      const transparentGroup = transparentGroups.get(batch.instanceId);
      if (transparentGroup) {
        scenePass?.end();
        scenePass = undefined;
        resources.transparency.encode(
          encoder,
          sceneTexture,
          depthView,
          this.#width,
          this.#height,
          transparentGroup.map((batch) => ({
            blendMode: batch.layer.blendMode,
            triangleCount: batch.vertexCount / 3,
            draw: (pass) =>
              drawSceneBatch(resources, pass, batch, "normal", composition.environment),
          })),
        );
        for (const batch of transparentGroup) captured.add(batch.instanceId);
        clearSceneDepth = true;
        continue;
      }
      const hasEffects = needsLayerIsolation(batch.layer);
      if (hasEffects) {
        const fusion = analyzeEffectFusion(batch.layer.effects);
        fusedEffectCount += fusion.fusedEffectCount;
        fusionGroupCount += fusion.fusedGroupCount;
        fusionBarrierCount += fusion.barrierCount;
        scenePass?.end();
        scenePass = undefined;
        activeEffectInstances.add(batch.instanceId);
        effectLayerCount += 1;
        effectOperationCount += resources.layerEffects.encode(
          encoder,
          sceneTexture,
          composition,
          batch.layer,
          batch.instanceId,
          batch.localTime ?? time,
          (layerPass) =>
            drawSceneBatch(resources, layerPass, batch, "normal", composition.environment),
        );
      } else {
        if (!scenePass) {
          scenePass = encoder.beginRenderPass({
            label: "Linear HDR direct layer group",
            colorAttachments: [{ view: sceneView, loadOp: "load", storeOp: "store" }],
            depthStencilAttachment: {
              view: depthView,
              depthClearValue: 1,
              depthLoadOp: clearSceneDepth ? "clear" : "load",
              depthStoreOp: "store",
            },
          });
          scenePassCount += 1;
          clearSceneDepth = false;
        }
        drawSceneBatch(resources, scenePass, batch, batch.layer.blendMode, composition.environment);
      }
    }
    const generatorDrawCount = drawnGenerators.size;
    scenePass?.end();
    const needsAuxiliarySurfaceData =
      usesAuxiliarySurfaceData(this.#bufferVisualization) ||
      beautyDepthOfField ||
      motionBlurRequested;
    let auxiliaryFrameValid = !needsAuxiliarySurfaceData;
    if (!auxiliaryFrameValid) {
      auxiliaryFrameValid = resources.auxiliaryBuffers.encode({
        encoder,
        vertexBuffer: resources.shapeBuffer,
        vertexCount: geometry.data.length / FLOATS_PER_VERTEX,
        batches: geometry.batches,
        motionVectors,
        mediaBindGroup: (batch) =>
          resources.precompositionSurfaces.bindingFor(batch.instanceId) ??
          resources.mediaTextures.bindGroup(batch.resourceInstanceId),
        generators: beautyMotionBlur
          ? []
          : sceneGenerators
              .map((generator) => resources.sceneGenerators.auxiliaryDraw(generator))
              .filter((draw) => draw !== undefined),
      });
    }
    const framePosition =
      shutterInterval.duration > Number.EPSILON
        ? (time - shutterInterval.openTime) / shutterInterval.duration
        : 0.5;
    const beautyMotionBlurValid =
      beautyMotionBlur &&
      auxiliaryFrameValid &&
      motionVectors !== undefined &&
      resources.motionBlur.encode(encoder, {
        ...motionBlurSettings,
        framePosition,
        maximumRadius: Math.max(
          1,
          Math.min(256, 256 * (this.#width / Math.max(composition.width, 1))),
        ),
      });
    if (beautyDepthOfField && beautyMotionBlurValid !== this.#depthEffectsUseMotionBlur) {
      this.#depthEffectsUseMotionBlur = beautyMotionBlurValid;
      resources.depthEffects.setSources(
        this.#width,
        this.#height,
        beautyMotionBlurValid ? resources.motionBlur.outputTexture : resources.sceneTexture,
        resources.auxiliaryBuffers.textures.get("worldPosition"),
        resources.auxiliaryBuffers.transparentWorldPosition,
        resources.auxiliaryBuffers.peeledWorldPosition,
        resources.auxiliaryBuffers.frontLayerColor,
        resources.auxiliaryBuffers.peeledLayerColor,
      );
    }
    resources.surfacePostEffects.setSelection(
      selectedRenderId(
        geometry.batches,
        selectedLayerId,
        sceneGenerators.map((generator) => generator.selectionId),
      ),
    );
    resources.surfacePostEffects.setMotionShutterScale(
      resources.auxiliaryBuffers.motionShutterScale,
    );
    resources.layerEffects.sweep(activeEffectInstances);
    const sceneTimingEnd = encoder.beginRenderPass({
      label: "Composition timing marker",
      timestampWrites: resources.gpuProfiler.writes(undefined, 5),
      colorAttachments: [{ view: sceneView, loadOp: "load", storeOp: "store" }],
    });
    sceneTimingEnd.end();
    if (this.#pendingFrameReadback && !this.#exportTexture) {
      this.#exportTexture = this.#device.createTexture({
        label: "Owned production output",
        size: [this.#width, this.#height],
        format: this.#format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
    }
    const outputTexture =
      this.#pendingFrameReadback && this.#exportTexture
        ? this.#exportTexture
        : this.#context.getCurrentTexture();
    const output = outputTexture.createView();
    const postPass = encoder.beginRenderPass({
      label: "Fused effects + ACES display transform",
      timestampWrites: resources.gpuProfiler.writes(6, 7),
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
    const beautyPostBindGroup =
      beautyMotionBlurValid && resources.motionBlurPostBindGroup
        ? resources.motionBlurPostBindGroup
        : resources.postBindGroup;
    if (beautyDepthOfField && auxiliaryFrameValid) {
      resources.depthEffects.encode(postPass, "depthOfField");
    } else if (postRoute === "beauty") {
      postPass.setPipeline(resources.postPipeline);
      postPass.setBindGroup(0, beautyPostBindGroup);
      postPass.draw(3);
    } else if (isDepthEffectVisualization(this.#bufferVisualization)) {
      resources.depthEffects.encode(postPass, this.#bufferVisualization);
    } else if (isSurfaceEffectVisualization(this.#bufferVisualization)) {
      resources.surfacePostEffects.encode(postPass, this.#bufferVisualization);
    } else if (this.#bufferVisualization === "beauty") {
      postPass.setPipeline(resources.postPipeline);
      postPass.setBindGroup(0, beautyPostBindGroup);
      postPass.draw(3);
    } else resources.bufferVisualizer.encode(postPass, this.#bufferVisualization);
    postPass.end();
    this.#pendingFrameReadback?.encode(encoder, outputTexture);
    const collectTimestamps = resources.gpuProfiler.encodeReadback(encoder);
    const verifyTransparency = resources.transparency.finishFrame(encoder);
    this.#device.queue.submit([encoder.finish()]);
    verifyTransparency();
    resources.mediaTextures.submitted();
    const textMotionBlurStats = resources.mediaTextures.textMotionBlurFrameStats;
    if (collectTimestamps) resources.gpuProfiler.readback();
    const cpuMs = performance.now() - started;
    const sample = frameCadenceSample(frameInterval, continuousPlayback);
    this.#smoothedFrameMs = this.#smoothedFrameMs * 0.9 + sample * 0.1;
    const shadowDrawCalls = shadowsEnabled
      ? geometry.batches.filter((batch) => batch.layer.threeDimensional).length
      : 0;
    return {
      fps: Math.min(240, 1000 / this.#smoothedFrameMs),
      frameMs: this.#smoothedFrameMs,
      cpuMs,
      gpuMs: resources.gpuProfiler.totalMs(),
      drawCalls:
        1 +
        (beautyMotionBlurValid ? 3 : 0) +
        geometry.batches.length +
        surfaceFrame.surfaceCount +
        shadowDrawCalls +
        effectLayerCount * 2 +
        adjustmentEffectLayerCount +
        generatorDrawCount +
        textMotionBlurStats.drawCount +
        resources.transparency.drawCount -
        captured.size,
      passCount:
        3 +
        (beautyMotionBlurValid ? 3 : 0) +
        Number(shadowsEnabled) +
        scenePassCount +
        effectLayerCount * 3 +
        adjustmentEffectLayerCount +
        surfaceFrame.surfaceCount +
        textMotionBlurStats.passCount +
        resources.transparency.passCount,
      dirtyNodes: (evaluation.cacheHit ? 0 : sceneLayers.length) + effectOperationCount,
      cacheHitRate: this.#evaluationCache.hitRate(),
      estimatedVramMb: memory.estimatedBytes / 1024 / 1024,
      transientTextureCount:
        6 +
        (beautyMotionBlurValid ? 3 : 0) +
        surfaceFrame.residentTextureCount +
        textMotionBlurStats.transientTextureCount,
      memoryBudgetMb: memory.budgetMb,
      memoryPressure: memory.pressure,
      shadowMapSize: memory.shadowMapSize,
      fusedEffectCount,
      fusionGroupCount,
      fusionBarrierCount,
      temporalCacheMb: this.#evaluationCache.memoryBytes() / 1024 / 1024,
      passTimings: resources.gpuProfiler.passTimings(),
    };
  }
  async complete(): Promise<void> {
    this.#assertActive();
    await this.#device.queue.onSubmittedWorkDone();
    await this.#resources.transparency.complete();
  }
  setMemoryBudget(megabytes?: number): void {
    this.#assertActive();
    this.#memoryBudgetMb = megabytes;
    this.#configureAuxiliaryBuffers();
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#exportTexture?.destroy();
    this.#pendingFrameReadback?.abort();
    this.#pendingFrameReadback = undefined;
    this.#resources.destroy();
    this.#evaluationCache.clear();
    this.#context.unconfigure();
    this.#device.destroy();
  }
  #assertActive(): void {
    if (this.#disposed) throw new Error("WebGPU renderer is disposed");
  }
  #configureAuxiliaryBuffers(): void {
    this.#bufferVisualization = this.#resources.auxiliaryBuffers.configureVisualization(
      this.#resources.bufferVisualizer,
      this.#bufferVisualization,
      this.#width,
      this.#height,
      this.#memoryBudgetMb,
      this.#beautyDepthOfFieldActive || this.#beautyMotionBlurActive,
      this.#beautyDepthOfFieldActive,
    );
    this.diagnostics.depthOfFieldTier = this.#resources.auxiliaryBuffers.depthOfFieldTier;
    this.diagnostics.depthOfFieldDegradedReason =
      this.#resources.auxiliaryBuffers.depthOfFieldDiagnostic;
    this.#resources.motionBlur.setSources(
      this.#width,
      this.#height,
      this.#beautyMotionBlurActive ? this.#resources.sceneTexture : undefined,
      this.#beautyMotionBlurActive
        ? this.#resources.auxiliaryBuffers.textures.get("motionVector")
        : undefined,
      this.#beautyMotionBlurActive
        ? this.#resources.auxiliaryBuffers.textures.get("objectId")
        : undefined,
      (this.#memoryBudgetMb ?? 512) * 1024 * 1024 * 0.25,
    );
    this.#resources.motionBlurPostBindGroup = this.#resources.motionBlur.outputTexture
      ? this.#resources.createPostBindGroup(
          this.#resources.motionBlur.outputTexture,
          "motion-blurred scene",
        )
      : undefined;
    this.#depthEffectsUseMotionBlur = false;
    this.#resources.depthEffects.setSources(
      this.#width,
      this.#height,
      this.#resources.sceneTexture,
      this.#resources.auxiliaryBuffers.textures.get("worldPosition"),
      this.#resources.auxiliaryBuffers.transparentWorldPosition,
      this.#resources.auxiliaryBuffers.peeledWorldPosition,
      this.#resources.auxiliaryBuffers.frontLayerColor,
      this.#resources.auxiliaryBuffers.peeledLayerColor,
    );
    this.#resources.surfacePostEffects.setSources(
      this.#width,
      this.#height,
      this.#resources.sceneTexture,
      this.#resources.auxiliaryBuffers.textures.get("objectId"),
      this.#resources.auxiliaryBuffers.textures.get("motionVector"),
    );
  }
}
export {
  releaseFailedWebGpuInitialization,
  shouldReportGpuDeviceLoss,
} from "./gpu/device-lifecycle";
