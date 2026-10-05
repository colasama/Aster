import {
  compositionMotionBlurSettings,
  layerMotionBlurEnabled,
  layerSupportsMotionBlur,
  motionBlurInterval,
} from "../core/animation/motion-blur";
import { AudioAnalysisProvider } from "../core/audio/audio-analysis-provider";
import { logger } from "../core/logger";
import { sourceForLayer } from "../core/media/footage-source";
import { type AntiAliasingMode, antiAliasingScale } from "../core/rendering/anti-aliasing";
import {
  type GpuMemorySnapshot,
  resolveGpuMemoryBudget,
} from "../core/rendering/gpu-memory-policy";
import type { CachedPreviewFrame } from "../core/rendering/preview-frame-cache";
import {
  copyRenderSnapshotIdentity,
  type RenderSnapshotIdentity,
  validateRenderSnapshotIdentity,
} from "../core/rendering/render-snapshot";
import { evaluateCameraBasis } from "../core/scene/camera-rig";
import { flattenSceneLayers } from "../core/scene/scene-evaluation";
import type { Composition, GpuDiagnostics, Project, RendererMetrics } from "../core/types";
import { requestPreferredGpuAdapter } from "../desktop/gpu-preference";
import { executeFinalOutput } from "./compositing/execute-final-output";
import { executeRootScene } from "./compositing/execute-root-scene";
import { planRootSceneStack } from "./compositing/render-stack";
import { planRootSceneCommands } from "./compositing/root-scene-commands";
import { AntiAliasingRenderer, planAntiAliasing } from "./effects/anti-aliasing";
import { depthEffectSettingsFromCameraOptics } from "./effects/depth-effects";
import { effectExecution } from "./effects/layer-effect-plan";
import { selectedRenderId } from "./effects/surface-post-effects";
import { buildCameraPlan, readCameraPlan } from "./frame-plan/camera-plan";
import { compositionIdentityFromString } from "./frame-plan/composition-identity";
import { buildFinalOutputPlan, readFinalOutputPlan } from "./frame-plan/final-output-plan";
import { buildMotionReconstructionPlan } from "./frame-plan/motion-reconstruction-plan";
import { buildFrameHeader, buildRootPostUniformPlan } from "./frame-plan/root-post-plan";
import { uploadRootPostUniformPlan } from "./frame-plan/root-post-upload";
import { buildRootScenePlan, readRootScenePlan } from "./frame-plan/root-scene-plan";
import { buildSceneBufferPlan } from "./frame-plan/scene-buffer-plan";
import {
  drawSceneShadows,
  prepareSceneBuffers,
  uploadSceneBuffers,
} from "./frame-plan/scene-buffer-upload";
import { bindSceneMediaPlan, resolveSceneMediaPlan } from "./frame-plan/scene-media-plan";
import {
  buildTextFrameSamplePlans,
  readTextFrameSamplePlans,
} from "./frame-plan/temporal-text-frame";
import { buildSceneGeometry } from "./geometry/geometry";
import { productionDepthOfFieldAllocationError } from "./gpu/auxiliary-buffer-budget";
import {
  releaseFailedWebGpuInitialization,
  shouldReportGpuDeviceLoss,
} from "./gpu/device-lifecycle";
import {
  combineFrameResourceBarriers,
  ExactFrameCaptureQueue,
  type ExactFrameResourceBarrier,
} from "./gpu/exact-frame-resource-barrier";
import { frameCadenceSample } from "./gpu/frame-cadence";
import {
  type FrameReadbackTicket,
  GpuFrameReadbackPool,
  type RawFramePixelFormat,
  type RawVideoFrame,
  validateReadbackDestination,
} from "./gpu/frame-readback";
import { planGpuMemory } from "./gpu/gpu-memory-budget";
import { initializeGpuResources } from "./gpu/initialize-gpu-resources";
import { type BufferVisualization, usesAuxiliarySurfaceData } from "./gpu/render-buffers";
import { MaterialTextureRenderer } from "./media/material-textures";
import { RendererResources } from "./renderer-resources";
import { evaluateSceneCamera } from "./scene/scene-camera";
import { SceneEvaluationCache } from "./scene/scene-evaluation-cache";
import type { PreparedSceneGenerator } from "./scene/scene-generator-host";
import { buildSceneLighting, shadowMapSize } from "./scene/scene-lighting";
import { buildTimeAddressedMotionVectors } from "./scene/time-addressed-motion-vectors";
import { planTextMotionBlurFrame } from "./text/text-motion-blur-plan";
import { expandTextSceneGeometry } from "./text/text-scene-geometry";
import { prepareTextSceneRasters } from "./text/text-scene-preparation";

const SCENE_FORMAT: GPUTextureFormat = "rgba16float";

/** How far ahead of the playhead preview prepares media so arrival frames are already decoded. */
const MEDIA_PREFETCH_LOOKAHEAD_SECONDS = 0.5;

export class WebGpuRenderer {
  readonly #resources: RendererResources;
  readonly diagnostics: GpuDiagnostics;
  readonly #device: GPUDevice;
  readonly #context: GPUCanvasContext;
  readonly #format: GPUTextureFormat;
  #pendingFrameReadback?: FrameReadbackTicket;
  readonly #frameCaptures = new ExactFrameCaptureQueue<RawVideoFrame>();
  #width = 1;
  #height = 1;
  #outputWidth = 1;
  #outputHeight = 1;
  #antiAliasingMode: AntiAliasingMode = "off";
  readonly #antiAliasing: AntiAliasingRenderer;
  #memoryBudgetMb?: number;
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
  readonly #audioAnalysis: AudioAnalysisProvider;
  readonly #frameResources: ExactFrameResourceBarrier;
  /** Separate from export readback so in-flight preview captures never block AA or resize. */
  readonly #cacheReadback: GpuFrameReadbackPool;
  #cacheCapture?: (frame?: CachedPreviewFrame) => void;
  /** The cached frame the canvas shows, so repeated display refreshes skip the upload. */
  #presentedCachedFrame?: CachedPreviewFrame;
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
    this.#antiAliasing = new AntiAliasingRenderer(device, format);
    this.#audioAnalysis = new AudioAnalysisProvider(invalidate);
    this.#cacheReadback = new GpuFrameReadbackPool(device, format);
    this.#frameResources = combineFrameResourceBarriers(
      this.#resources.mediaTextures,
      this.#audioAnalysis,
    );
  }
  static async create(
    canvas: HTMLCanvasElement,
    invalidate: () => void = () => undefined,
  ): Promise<WebGpuRenderer> {
    logger.debug("webgpu", "initialization_started");
    if (!navigator.gpu) throw new Error("WebGPU is unavailable");
    const adapter = await requestPreferredGpuAdapter();
    if (!adapter) throw new Error("No compatible GPU adapter was found");
    const timestampQueries = adapter.features.has("timestamp-query");
    const requiredFeatures: GPUFeatureName[] = timestampQueries ? ["timestamp-query"] : [];
    const device = await adapter.requestDevice({
      requiredFeatures,
      // 4K SSAA 4x needs 15360x8640 targets, beyond WebGPU's default 8192 limit.
      requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D },
    });
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
      const { diagnostics, memoryBudgetMb } = await initializeGpuResources(adapter, device, format);
      const context = canvas.getContext("webgpu");
      if (!context) throw new Error("Unable to create a WebGPU canvas context");
      device.pushErrorScope("validation");
      renderer = new WebGpuRenderer(device, context, format, diagnostics, invalidate);
      renderer.#memoryBudgetMb = memoryBudgetMb;
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
    this.#presentedCachedFrame = undefined;
    const outputWidth = Math.max(1, Math.floor(width));
    const outputHeight = Math.max(1, Math.floor(height));
    const plan = planAntiAliasing(
      this.#activeAntiAliasing,
      outputWidth,
      outputHeight,
      this.#device.limits.maxTextureDimension2D,
      this.#memoryBudgetMb,
    );
    if (!this.#resources.frameReadback.reset())
      throw new Error("Cannot change render targets while frame readbacks are in flight");
    this.#outputWidth = outputWidth;
    this.#outputHeight = outputHeight;
    this.#width = plan.renderWidth;
    this.#height = plan.renderHeight;
    this.#antiAliasing.resize(this.#activeAntiAliasing, this.#width, this.#height);
    this.#resources.resizeSceneTargets(this.#width, this.#height, this.#context, this.#format);
    this.#configureAuxiliaryBuffers();
  }
  get bufferVisualization(): BufferVisualization {
    return this.#bufferVisualization;
  }
  setBufferVisualization(mode: BufferVisualization): BufferVisualization {
    const previous = this.#bufferVisualization;
    if ((previous === "beauty") !== (mode === "beauty")) {
      planAntiAliasing(
        mode === "beauty" ? this.#antiAliasingMode : "off",
        this.#outputWidth,
        this.#outputHeight,
        this.#device.limits.maxTextureDimension2D,
        this.#memoryBudgetMb,
      );
      if (!this.#resources.frameReadback.reset())
        throw new Error("Cannot change render targets while frame readbacks are in flight");
    }
    this.#bufferVisualization = mode;
    if ((previous === "beauty") !== (mode === "beauty"))
      this.resize(this.#outputWidth, this.#outputHeight);
    this.#configureAuxiliaryBuffers();
    return this.#bufferVisualization;
  }
  get exportPixelFormat(): RawFramePixelFormat {
    return this.#resources.frameReadback.pixelFormat;
  }
  get outputWidth(): number {
    return this.#outputWidth;
  }
  get outputHeight(): number {
    return this.#outputHeight;
  }
  get #activeAntiAliasing(): AntiAliasingMode {
    return this.#bufferVisualization === "beauty" ? this.#antiAliasingMode : "off";
  }
  configureBeautyTarget(width: number, height: number, mode: AntiAliasingMode): void {
    if (
      mode === this.#antiAliasingMode &&
      this.#bufferVisualization === "beauty" &&
      width === this.#outputWidth &&
      height === this.#outputHeight &&
      this.#resources.sceneTexture
    )
      return;
    // Validate before changing persistent renderer state, so a rejected setting can be corrected.
    planAntiAliasing(
      mode,
      width,
      height,
      this.#device.limits.maxTextureDimension2D,
      this.#memoryBudgetMb,
    );
    if (!this.#resources.frameReadback.reset())
      throw new Error("Cannot change anti-aliasing while frame readbacks are in flight");
    this.#antiAliasingMode = mode;
    this.#bufferVisualization = "beauty";
    this.resize(width, height);
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
    snapshot: RenderSnapshotIdentity,
    project?: Project,
    synchronizeVideo = false,
    destination?: ArrayBuffer,
  ): Promise<RawVideoFrame> {
    this.#assertActive();
    const capturedSnapshot = copyRenderSnapshotIdentity(snapshot);
    if (destination !== undefined)
      validateReadbackDestination(destination, this.#outputWidth, this.#outputHeight);
    // Video exports hold the discovery capture until every active video shows its exact frame,
    // so the only readback submitted is the exact one.
    return this.#frameCaptures.capture(
      (discovery) =>
        this.#captureRawFrame(
          composition,
          time,
          capturedSnapshot,
          project,
          synchronizeVideo && discovery,
          destination,
        ),
      this.#frameResources,
    );
  }
  /** Captures installed raster resources only when requested by the dedicated parity harness. */
  captureRasterResources(scope: string, known: Map<string, string>) {
    this.#assertActive();
    return this.#resources.mediaTextures.captureRasterResources(scope, known);
  }
  #captureRawFrame(
    composition: Composition,
    time: number,
    snapshot: RenderSnapshotIdentity,
    project?: Project,
    holdInexactVideo = false,
    destination?: ArrayBuffer,
  ): Promise<RawVideoFrame> {
    if (this.#pendingFrameReadback)
      return Promise.reject(new Error("A GPU frame readback is already being encoded"));
    const ticket = this.#resources.frameReadback.reserve(this.#outputWidth, this.#outputHeight);
    this.#pendingFrameReadback = ticket;
    try {
      // The first capture exists to register pending media; holding keeps its incomplete
      // frame off the preview canvas. The barrier waits and recaptures the ready frame.
      this.render(composition, time, snapshot, false, project, undefined, true, holdInexactVideo);
      const productionError = this.productionRenderError;
      if (productionError) throw new Error(productionError);
    } catch (error) {
      ticket.abort();
      throw error;
    } finally {
      this.#pendingFrameReadback = undefined;
    }
    return ticket.read(destination);
  }
  render(
    composition: Composition,
    time: number,
    snapshot: RenderSnapshotIdentity,
    playing = false,
    project?: Project,
    selectedLayerId?: string,
    holdPendingMedia = false,
    holdInexactVideo = false,
  ): RendererMetrics {
    // A capture is armed for exactly one render and always settles once: with the frame, or with
    // undefined when the render held, failed, or was incomplete.
    const armed = this.#cacheCapture;
    this.#cacheCapture = undefined;
    let settled = false;
    const settleCapture = armed
      ? (frame?: CachedPreviewFrame) => {
          if (settled) return;
          settled = true;
          armed(frame);
        }
      : undefined;
    try {
      return this.#renderFrame(
        composition,
        time,
        snapshot,
        playing,
        project,
        selectedLayerId,
        holdPendingMedia,
        holdInexactVideo,
        settleCapture,
      );
    } catch (error) {
      this.#resources.mediaTextures.abortFrame();
      settleCapture?.();
      throw error;
    }
  }
  #renderFrame(
    composition: Composition,
    time: number,
    snapshot: RenderSnapshotIdentity,
    playing = false,
    project?: Project,
    selectedLayerId?: string,
    holdPendingMedia = false,
    holdInexactVideo = false,
    cacheCapture?: (frame?: CachedPreviewFrame) => void,
  ): RendererMetrics {
    const resources = this.#resources;
    this.#assertActive();
    validateRenderSnapshotIdentity(snapshot);
    this.#presentedCachedFrame = undefined;
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
    const evaluatedTextMotionBlur = textMotionBlurRequested
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
    const framePlanInput = {
      snapshot,
      compositionId: composition.id,
      time,
      frameRate: composition.frameRate,
      target: { width: this.#outputWidth, height: this.#outputHeight },
      renderTarget: { width: this.#width, height: this.#height },
      antiAliasing: this.#activeAntiAliasing,
    };
    const evaluatedCamera = evaluateSceneCamera(composition, time);
    const textMotionBlur = readTextFrameSamplePlans(
      buildTextFrameSamplePlans(framePlanInput, evaluatedTextMotionBlur),
    );
    const camera = evaluatedCamera
      ? readCameraPlan(buildCameraPlan(framePlanInput, evaluatedCamera))
      : undefined;
    const currentScenes =
      textMotionBlur.exposureResourceIds.size > 0 ? new Set(evaluation.sceneLayers) : undefined;
    const sceneLayers =
      textMotionBlur.exposureResourceIds.size > 0
        ? evaluatedTextMotionBlur.renderSceneLayers.filter(
            (scene) =>
              currentScenes?.has(scene) ||
              textMotionBlur.exposureResourceIds.has(scene.resourceInstanceId),
          )
        : evaluation.sceneLayers;
    const textBounds = prepareTextSceneRasters(
      composition,
      sceneLayers,
      resources.mediaTextures,
      previewResolutionScale,
      textMotionBlur.plans,
    );
    const geometry = expandTextSceneGeometry(
      composition,
      sceneLayers,
      textMotionBlur.exposureResourceIds.size > 0
        ? buildSceneGeometry(composition, [...sceneLayers], camera)
        : evaluation.geometry,
      camera,
      (id) => textBounds.get(id),
    );
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
    resources.sceneGenerators.beginFrame(() =>
      this.#audioAnalysis.frame(project, composition, time),
    );
    const surfaceFrame = resources.precompositionSurfaces.prepare(
      project,
      sceneLayers,
      playing,
      this.#memoryBudgetMb,
      this.#bufferVisualization === "beauty",
      antiAliasingScale(this.#activeAntiAliasing),
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
      const motionTextBounds = resources.mediaTextures.snapshotTextBounds();
      const geometryAt = (sampleTime: number) => {
        const sample = this.#evaluationCache.evaluate(
          composition,
          project,
          sampleTime,
          this.#width,
          this.#height,
        );
        return expandTextSceneGeometry(
          composition,
          sample.sceneLayers,
          sample.geometry,
          evaluateSceneCamera(composition, sampleTime),
          (id) => motionTextBounds.get(id),
        );
      };
      motionVectors = buildTimeAddressedMotionVectors(
        geometry,
        geometryAt(shutterInterval.openTime),
        geometryAt(shutterInterval.closeTime),
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
    const generatorHeader = buildFrameHeader(framePlanInput);
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
          generatorHeader,
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
        this.#antiAliasing.estimatedBytes +
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
    if (this.#activeAntiAliasing !== "off" && memory.pressure === "critical")
      throw new Error(
        `Anti-aliasing ${this.#activeAntiAliasing} exceeds the ${memory.budgetMb} MB GPU budget. Choose a lower AA mode or resolution.`,
      );
    const shadowsEnabled =
      shadowQuality !== "off" && primaryLight?.kind !== "point" && memory.shadowMapSize > 1;
    resources.configureShadowMap(memory.shadowMapSize);
    const scenePlan = buildSceneBufferPlan({
      ...framePlanInput,
      geometry,
      lighting: buildSceneLighting(sceneLayers, composition, shadowsEnabled, cameraPosition),
      motionVectors,
      shadowsEnabled,
    });
    const sceneBuffers = prepareSceneBuffers(scenePlan);
    uploadSceneBuffers(sceneBuffers, {
      queue: this.#device.queue,
      lightingBuffer: resources.lightingBuffer,
      get shapeBuffer() {
        return resources.shapeBuffer;
      },
      ensureShapeBuffer: (bytes) => resources.ensureShapeBuffer(bytes),
    });
    const sceneBatches = sceneBuffers.draws.map((draw, index) => ({
      ...geometry.batches[index],
      ...draw,
    }));
    const effectPlans = resources.layerEffects.prepareEffects(
      sceneLayers,
      composition,
      scenePlan.metadata.header,
    );
    if (
      !resources.materialTextures &&
      ((composition.environment?.enabled &&
        sceneBatches.some((batch) => batch.layer.kind === "mesh")) ||
        sceneBatches.some((batch) => batch.layer.mesh?.materialTextures?.normal))
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
    resources.materialTextures?.prepare(composition, sceneBatches, scenePlan.metadata.header);
    for (const scene of sceneLayers) {
      if (scene.layer.kind === "image" || scene.layer.kind === "video")
        resources.mediaTextures.prepareMedia(
          scene.layer,
          sourceForLayer(project, scene.layer),
          scene.localTime,
          playing,
          scene.resourceInstanceId,
          previewResolutionScale,
        );
    }
    const activeMediaInstanceIds = new Set([
      ...sceneLayers
        .filter(
          (scene) =>
            scene.layer.kind === "text" ||
            scene.layer.kind === "image" ||
            scene.layer.kind === "video",
        )
        .map((scene) => scene.resourceInstanceId),
      ...surfaceFrame.mediaInstanceIds,
    ]);
    const prefetchedInstanceIds = new Set<string>();
    if (holdPendingMedia && playing) {
      // Prepare media one lookahead window ahead so layers becoming visible already hold a
      // decoded texture or an exact video frame instead of arriving as placeholder color.
      // Instances active in the current frame are skipped: re-preparing them with
      // playing = false would pause or re-seek media the current frame just started.
      const aheadTimes = [time + MEDIA_PREFETCH_LOOKAHEAD_SECONDS];
      if (composition.duration > 0 && aheadTimes[0] >= composition.duration)
        aheadTimes.push(aheadTimes[0] - composition.duration);
      for (const aheadTime of aheadTimes)
        for (const scene of flattenSceneLayers(composition, project, aheadTime)) {
          if (
            (scene.layer.kind !== "image" && scene.layer.kind !== "video") ||
            activeMediaInstanceIds.has(scene.resourceInstanceId) ||
            prefetchedInstanceIds.has(scene.resourceInstanceId)
          )
            continue;
          resources.mediaTextures.prepareMedia(
            scene.layer,
            sourceForLayer(project, scene.layer),
            scene.localTime,
            false,
            scene.resourceInstanceId,
            previewResolutionScale,
          );
          prefetchedInstanceIds.add(scene.resourceInstanceId);
        }
    }
    resources.mediaTextures.sweep(new Set([...activeMediaInstanceIds, ...prefetchedInstanceIds]));
    if (
      holdPendingMedia &&
      (sceneBatches.some(
        (batch) =>
          (batch.layer.kind === "image" || batch.layer.kind === "video") &&
          !resources.mediaTextures.mediaReady(batch.resourceInstanceId),
      ) ||
        [...surfaceFrame.mediaInstanceIds].some(
          (instanceId) => !resources.mediaTextures.mediaReady(instanceId),
        ) ||
        (holdInexactVideo &&
          [...activeMediaInstanceIds].some(
            (instanceId) => !resources.mediaTextures.videoFrameExact(instanceId),
          )))
    ) {
      // Keep the previously presented frame until every visible layer can draw real media;
      // a finished install or a failure both invalidate and release the hold.
      resources.mediaTextures.abortFrame();
      cacheCapture?.();
      return {
        fps: Math.min(240, 1000 / this.#smoothedFrameMs),
        frameMs: this.#smoothedFrameMs,
        cpuMs: performance.now() - started,
        gpuMs: 0,
        drawCalls: 0,
        passCount: 0,
        dirtyNodes: 0,
        cacheHitRate: this.#evaluationCache.hitRate(),
        estimatedVramMb: memory.estimatedBytes / 1024 / 1024,
        transientTextureCount: 0,
        memoryBudgetMb: memory.budgetMb,
        memoryPressure: memory.pressure,
        mediaPending: true,
      };
    }
    const { target, renderTarget } = framePlanInput;
    const plannedMediaIds = new Set(
      sceneBatches
        .filter(
          (batch) =>
            batch.layer.kind === "image" ||
            batch.layer.kind === "video" ||
            (batch.layer.kind === "text" &&
              resources.mediaTextures.hasPlannedRaster(batch.resourceInstanceId)),
        )
        .map((batch) => batch.resourceInstanceId),
    );
    const mediaBindings = resources.mediaTextures.acquireFrameBindings(
      [...new Set([...plannedMediaIds, ...surfaceFrame.mediaInstanceIds])],
      framePlanInput.snapshot.snapshotScope,
    );
    const surfacePlans = resources.precompositionSurfaces.planScenes(mediaBindings);
    const mediaPlan = bindSceneMediaPlan(
      scenePlan,
      sceneBatches.flatMap((batch, draw_index) => {
        if (!plannedMediaIds.has(batch.resourceInstanceId)) return [];
        const hash = mediaBindings.hashFor(batch.resourceInstanceId);
        return [
          {
            draw_index,
            binding:
              hash === null ? { kind: "pending" as const } : { kind: "frame" as const, hash },
          },
        ];
      }),
    );
    for (const media of resolveSceneMediaPlan(mediaPlan, mediaBindings))
      sceneBatches[media.drawIndex].mediaResourceHash = media.hash;
    const renderStack = planRootSceneStack(sceneLayers, sceneBatches);
    const rootCommands = planRootSceneCommands(
      renderStack,
      new Map([...effectPlans].map(([id, effect]) => [id, effectExecution(effect)])),
      new Set(generatorByInstance.keys()),
      composition.background,
    );
    const rootPlan = readRootScenePlan(
      buildRootScenePlan(scenePlan.metadata.header, rootCommands, renderStack.draws),
    );
    const postPlan = buildRootPostUniformPlan(framePlanInput);
    uploadRootPostUniformPlan(postPlan, {
      queue: this.#device.queue,
      buffer: resources.postUniformBuffer,
      target,
      renderTarget,
      antiAliasing: this.#activeAntiAliasing,
    });
    if (!resources.sceneTexture || !resources.postBindGroup)
      this.resize(this.#outputWidth, this.#outputHeight);
    const encoder = this.#device.createCommandEncoder({ label: "Aster frame render graph" });
    resources.mediaTextures.flush(encoder, postPlan.metadata.header);
    resources.precompositionSurfaces.encode(encoder, surfacePlans, mediaBindings);
    const compute = encoder.beginComputePass({
      label: sceneGenerators.some((generator) => generator.lodApplied)
        ? "Scene generators · bounded LOD"
        : "Scene generators",
      timestampWrites: resources.gpuProfiler.writes(0, 1),
    });
    for (const generator of sceneGenerators)
      resources.sceneGenerators.encodeCompute(compute, generator);
    compute.end();
    if (sceneBuffers.slice.shadows_enabled) {
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
      drawSceneShadows(sceneBuffers, shadowPass);
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
    const {
      scenePassCount,
      effectOperationCount,
      effectLayerCount,
      adjustmentEffectLayerCount,
      fusedEffectCount,
      fusionGroupCount,
      fusionBarrierCount,
      generatorDrawCount,
      activeEffectInstances,
      adjustmentErrors,
    } = executeRootScene({
      commands: rootPlan.commands,
      draws: rootPlan.draws,
      effects: effectPlans,
      generators: generatorByInstance,
      mediaBindings,
      resources,
      encoder,
      sceneTexture,
      sceneView,
      depthView,
    });
    this.diagnostics.adjustmentLayerError = adjustmentErrors[adjustmentErrors.length - 1]?.message;
    for (const { layerId, message } of adjustmentErrors) {
      const diagnosticKey = `${layerId}:${message}`;
      if (!this.#reportedAdjustmentErrors.has(diagnosticKey)) {
        this.#reportedAdjustmentErrors.add(diagnosticKey);
        logger.warn("webgpu", "adjustment_layer_skipped", { layerId, error: message });
      }
    }
    const needsAuxiliarySurfaceData =
      usesAuxiliarySurfaceData(this.#bufferVisualization) ||
      beautyDepthOfField ||
      motionBlurRequested;
    let auxiliaryFrameValid = !needsAuxiliarySurfaceData;
    if (!auxiliaryFrameValid) {
      const auxiliary = resources.auxiliaryBuffers.buildPlan({
        header: postPlan.metadata.header,
        vertexCount: sceneBuffers.slice.vertex_count,
        batches: sceneBatches,
        motionVectors: sceneBuffers.motionVectors,
        mediaBinding: (batch) => {
          const surface = resources.precompositionSurfaces.bindingFor(batch.instanceId);
          if (surface)
            return {
              texture: {
                kind: "surface",
                instance_id: compositionIdentityFromString(batch.instanceId),
              },
              binding: surface,
            };
          if (
            batch.layer.kind === "image" ||
            batch.layer.kind === "video" ||
            batch.mediaResourceHash !== undefined
          ) {
            const binding = mediaBindings.bindingForHash(batch.mediaResourceHash);
            return binding && batch.mediaResourceHash
              ? { texture: { kind: "media", hash: batch.mediaResourceHash }, binding }
              : undefined;
          }
          const binding = resources.mediaTextures.bindGroup(batch.resourceInstanceId);
          return binding
            ? {
                texture: {
                  kind: "raster_cache",
                  instance_id: compositionIdentityFromString(batch.resourceInstanceId),
                },
                binding,
              }
            : undefined;
        },
        generators: beautyMotionBlur
          ? []
          : sceneGenerators.flatMap((generator) => {
              const draw = resources.sceneGenerators.auxiliaryDraw(generator);
              return draw ? [{ instanceId: generator.instanceId, draw }] : [];
            }),
      });
      auxiliaryFrameValid = resources.auxiliaryBuffers.encodePlan(
        encoder,
        auxiliary.plan,
        resources.shapeBuffer,
        auxiliary.bindings,
      );
    }
    const motionPlan = buildMotionReconstructionPlan(postPlan.metadata.header, {
      requested:
        beautyMotionBlur && auxiliaryFrameValid && sceneBuffers.motionVectors !== undefined,
      resourcesAvailable: resources.motionBlur.ready,
      settings: motionBlurSettings,
      shutter: shutterInterval,
      compositionWidth: composition.width,
    });
    const beautyMotionBlurValid = resources.motionBlur.encodePlan(encoder, motionPlan);
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
        beautyMotionBlurValid ? "motion_blur" : "scene",
      );
    }
    resources.surfacePostEffects.setSelection(
      selectedRenderId(
        sceneBatches,
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
    const outputTexture = this.#context.getCurrentTexture();
    const output = outputTexture.createView();
    const outputPlan = buildFinalOutputPlan(postPlan.metadata.header, {
      visualization: this.#bufferVisualization,
      auxiliaryValid: auxiliaryFrameValid,
      beautyDepthOfField,
      motionBlurValid: beautyMotionBlurValid,
      motionBlurBindingAvailable: Boolean(resources.motionBlurPostBindGroup),
    });
    const { route: outputRoute } = readFinalOutputPlan(outputPlan);
    const postEffectPlan =
      outputRoute.kind === "depth"
        ? resources.depthEffects.buildPlan(postPlan.metadata.header, outputRoute.mode)
        : outputRoute.kind === "surface"
          ? resources.surfacePostEffects.buildPlan(postPlan.metadata.header, outputRoute.mode)
          : undefined;
    executeFinalOutput({
      plan: outputPlan,
      postEffectPlan,
      encoder,
      output,
      antiAliasing: this.#antiAliasing,
      resources,
    });
    this.#pendingFrameReadback?.encode(encoder, outputTexture);
    const cacheTicket =
      cacheCapture && this.#previewFrameComplete(activeMediaInstanceIds)
        ? this.#reserveCacheReadback()
        : undefined;
    cacheTicket?.encode(encoder, outputTexture);
    const collectTimestamps = resources.gpuProfiler.encodeReadback(encoder);
    this.#device.queue.submit([encoder.finish()]);
    resources.mediaTextures.submitted();
    if (cacheTicket && cacheCapture) {
      const width = this.#outputWidth;
      const height = this.#outputHeight;
      void cacheTicket.read().then(
        (frame) => cacheCapture({ ...frame, width, height }),
        (error: unknown) => {
          logger.debug("webgpu", "preview_cache_capture_failed", {
            message: error instanceof Error ? error.message : String(error),
          });
          cacheCapture();
        },
      );
    } else cacheCapture?.();
    const textMotionBlurStats = resources.mediaTextures.textMotionBlurFrameStats;
    if (collectTimestamps) resources.gpuProfiler.readback();
    const cpuMs = performance.now() - started;
    const sample = frameCadenceSample(frameInterval, continuousPlayback);
    this.#smoothedFrameMs = this.#smoothedFrameMs * 0.9 + sample * 0.1;
    const shadowDrawCalls = sceneBuffers.slice.shadows_enabled
      ? sceneBuffers.draws.filter((draw) => draw.castsShadow).length
      : 0;
    return {
      fps: Math.min(240, 1000 / this.#smoothedFrameMs),
      frameMs: this.#smoothedFrameMs,
      cpuMs,
      gpuMs: resources.gpuProfiler.totalMs(),
      drawCalls:
        1 +
        Number(this.#activeAntiAliasing !== "off") +
        (beautyMotionBlurValid ? 3 : 0) +
        sceneBatches.length +
        surfaceFrame.surfaceCount +
        shadowDrawCalls +
        effectLayerCount * 2 +
        adjustmentEffectLayerCount +
        generatorDrawCount +
        textMotionBlurStats.drawCount,
      passCount:
        3 +
        Number(this.#activeAntiAliasing !== "off") +
        (beautyMotionBlurValid ? 3 : 0) +
        Number(shadowsEnabled) +
        scenePassCount +
        effectLayerCount * 3 +
        adjustmentEffectLayerCount +
        surfaceFrame.surfaceCount +
        textMotionBlurStats.passCount,
      dirtyNodes: (evaluation.cacheHit ? 0 : sceneLayers.length) + effectOperationCount,
      cacheHitRate: this.#evaluationCache.hitRate(),
      estimatedVramMb: memory.estimatedBytes / 1024 / 1024,
      transientTextureCount:
        6 +
        Number(this.#activeAntiAliasing !== "off") +
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
  /**
   * Arms a readback of the next rendered frame. `onFrame` receives the pixels only if that frame
   * is complete: every visible media instance exact, materials and audio analysis settled, and no
   * generator missing, so a cached frame always equals a fresh render. Otherwise it receives
   * undefined, once, so background work can tell a skipped frame from one still in flight.
   */
  capturePreviewFrame(onFrame: (frame?: CachedPreviewFrame) => void): void {
    this.#assertActive();
    this.#cacheCapture?.();
    this.#cacheCapture = onFrame;
  }

  /** Resolves once media and audio analysis the last render waited on are ready. */
  waitForPreviewResources(): Promise<void> {
    return this.#frameResources.waitForFrameResources();
  }

  /** Presents a cached frame without rendering; false when it no longer fits the canvas. */
  presentCachedFrame(frame: CachedPreviewFrame): boolean {
    this.#assertActive();
    if (
      frame.width !== this.#outputWidth ||
      frame.height !== this.#outputHeight ||
      frame.pixelFormat !== this.exportPixelFormat ||
      frame.pixels.byteLength !== frame.width * frame.height * 4
    )
      return false;
    // The canvas keeps its last image between display refreshes; only upload a different frame.
    if (frame === this.#presentedCachedFrame) return true;
    this.#presentedCachedFrame = frame;
    this.#device.queue.writeTexture(
      { texture: this.#context.getCurrentTexture() },
      frame.pixels,
      { bytesPerRow: frame.width * 4, rowsPerImage: frame.height },
      [frame.width, frame.height],
    );
    return true;
  }

  #previewFrameComplete(activeMediaInstanceIds: ReadonlySet<string>): boolean {
    const media = this.#resources.mediaTextures;
    return (
      this.#bufferVisualization === "beauty" &&
      !this.productionRenderError &&
      !this.diagnostics.sceneGeneratorError &&
      !this.#audioAnalysis.hasPendingFrameResources &&
      !this.#resources.materialTextures?.hasPendingResources &&
      [...activeMediaInstanceIds].every(
        (instanceId) => media.mediaReady(instanceId) && media.videoFrameExact(instanceId),
      )
    );
  }

  #reserveCacheReadback(): FrameReadbackTicket | undefined {
    try {
      return this.#cacheReadback.reserve(this.#outputWidth, this.#outputHeight);
    } catch {
      // Every slot is still mapping, or a resize waits for in-flight captures: skip this frame.
      return undefined;
    }
  }

  async complete(): Promise<void> {
    this.#assertActive();
    await this.#device.queue.onSubmittedWorkDone();
  }
  setMemoryBudget(megabytes?: number, memory?: GpuMemorySnapshot): void {
    this.#assertActive();
    if (memory?.adapterKey === this.diagnostics.gpuMemory?.adapterKey)
      this.diagnostics.gpuMemory = memory;
    this.#memoryBudgetMb = resolveGpuMemoryBudget(
      megabytes ?? "auto",
      this.diagnostics.gpuMemory?.device,
    );
    this.#configureAuxiliaryBuffers();
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pendingFrameReadback?.abort();
    this.#pendingFrameReadback = undefined;
    this.#cacheCapture = undefined;
    this.#cacheReadback.destroy();
    this.#resources.destroy();
    this.#antiAliasing.destroy();
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
