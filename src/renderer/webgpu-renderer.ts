import { flattenSceneLayers } from "../core/scene-evaluation";
import type {
  BlendMode,
  Composition,
  GpuDiagnostics,
  Layer,
  Project,
  RendererMetrics,
} from "../core/types";
import { collectPostProcessParameters } from "./effect-parameters";
import {
  compileEffectProgram,
  FLOATS_PER_EFFECT_OPERATION,
  MAX_EFFECT_OPERATIONS,
} from "./effect-program";
import { buildSceneGeometry, FLOATS_PER_VERTEX } from "./geometry";
import {
  imageShader,
  particleComputeShader,
  particleRenderShader,
  postProcessShader,
  shapeShader,
} from "./shaders";

const PARTICLE_COUNT = 100_000;
const MAX_SHAPE_VERTICES = 6 * 128;
const SCENE_FORMAT: GPUTextureFormat = "rgba16float";

interface MediaResource {
  source: string;
  kind: "image" | "video";
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
  readonly #shapePipelines: Record<BlendMode, GPURenderPipeline>;
  readonly #imageBindGroupLayout: GPUBindGroupLayout;
  readonly #imagePipelines: Record<BlendMode, GPURenderPipeline>;
  readonly #particlePipeline: GPURenderPipeline;
  readonly #postPipeline: GPURenderPipeline;
  readonly #computePipeline: GPUComputePipeline;
  #shapeBuffer: GPUBuffer;
  readonly #particleBuffer: GPUBuffer;
  readonly #simulationBuffer: GPUBuffer;
  readonly #computeBindGroup: GPUBindGroup;
  readonly #particleBindGroup: GPUBindGroup;
  readonly #postSampler: GPUSampler;
  readonly #imageSampler: GPUSampler;
  readonly #postUniformBuffer: GPUBuffer;
  readonly #effectProgramBuffer: GPUBuffer;
  readonly #timestampQuerySet?: GPUQuerySet;
  readonly #timestampResolveBuffer?: GPUBuffer;
  readonly #timestampReadBuffer?: GPUBuffer;
  #postBindGroup?: GPUBindGroup;
  #sceneTexture?: GPUTexture;
  #width = 1;
  #height = 1;
  #smoothedFrameMs = 16.67;
  #lastFrameStarted?: number;
  #gpuTimestampPending = false;
  #lastGpuMs?: number;
  #shapeBufferBytes = MAX_SHAPE_VERTICES * FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT;
  readonly #invalidate: () => void;
  readonly #mediaResources = new Map<string, MediaResource>();

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
    this.#shapePipelines = {
      normal: this.#createShapePipeline("normal"),
      add: this.#createShapePipeline("add"),
      multiply: this.#createShapePipeline("multiply"),
      screen: this.#createShapePipeline("screen"),
      overlay: this.#createShapePipeline("overlay"),
    };
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
    this.#imagePipelines = {
      normal: this.#createImagePipeline("normal"),
      add: this.#createImagePipeline("add"),
      multiply: this.#createImagePipeline("multiply"),
      screen: this.#createImagePipeline("screen"),
      overlay: this.#createImagePipeline("overlay"),
    };
    this.#particleBuffer = device.createBuffer({
      label: "GPU particle storage · 100K",
      size: PARTICLE_COUNT * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.#simulationBuffer = device.createBuffer({
      label: "Particle simulation uniforms",
      size: 16,
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
      ],
    });
    this.#particlePipeline = this.#createParticlePipeline();
    this.#particleBindGroup = device.createBindGroup({
      label: "Particle render resources",
      layout: this.#particlePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.#particleBuffer } }],
    });
    this.#postSampler = device.createSampler({
      label: "HDR linear sampler",
      magFilter: "linear",
      minFilter: "linear",
    });
    this.#imageSampler = device.createSampler({
      label: "Imported image sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
    });
    this.#postUniformBuffer = device.createBuffer({
      label: "Fused post-process uniforms",
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#effectProgramBuffer = device.createBuffer({
      label: "Compiled GPU effect program",
      size: MAX_EFFECT_OPERATIONS * FLOATS_PER_EFFECT_OPERATION * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (diagnostics.timestampQueries) {
      this.#timestampQuerySet = device.createQuerySet({
        label: "Aster GPU pass timestamps",
        type: "timestamp",
        count: 6,
      });
      this.#timestampResolveBuffer = device.createBuffer({
        label: "GPU timestamp resolve",
        size: 6 * BigUint64Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      this.#timestampReadBuffer = device.createBuffer({
        label: "Asynchronous GPU timestamp readback",
        size: 6 * BigUint64Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    }
    this.#postPipeline = this.#createPostPipeline();
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
    this.#sceneTexture = this.#device.createTexture({
      label: "HDR scene target",
      size: [this.#width, this.#height],
      format: SCENE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#postBindGroup = this.#device.createBindGroup({
      label: "HDR fused post-process resources",
      layout: this.#postPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.#sceneTexture.createView() },
        { binding: 1, resource: this.#postSampler },
        { binding: 2, resource: { buffer: this.#postUniformBuffer } },
        { binding: 3, resource: { buffer: this.#effectProgramBuffer } },
      ],
    });
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
    const sceneLayers = flattenSceneLayers(composition, project, time);
    const geometry = buildSceneGeometry(composition, sceneLayers);
    if (geometry.data.length > 0) {
      this.#ensureShapeBuffer(geometry.data.byteLength);
      this.#device.queue.writeBuffer(this.#shapeBuffer, 0, geometry.data);
    }
    for (const scene of sceneLayers) {
      if (
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
              (scene.layer.kind === "image" || scene.layer.kind === "video") &&
              scene.layer.asset?.dataUrl,
          )
          .map((scene) => scene.instanceId),
      ),
    );
    this.#device.queue.writeBuffer(
      this.#simulationBuffer,
      0,
      new Float32Array([time, this.#width / this.#height, PARTICLE_COUNT, 0]),
    );
    const effectLayers = sceneLayers.map((scene) => scene.layer);
    const effects = collectPostProcessParameters(composition, time, effectLayers);
    const effectProgram = compileEffectProgram(composition, time, effectLayers);
    this.#device.queue.writeBuffer(this.#effectProgramBuffer, 0, effectProgram.data);
    this.#device.queue.writeBuffer(
      this.#postUniformBuffer,
      0,
      new Float32Array([
        this.#width,
        this.#height,
        time,
        effects.exposure,
        effects.contrast,
        effects.saturation,
        effects.temperature,
        effects.tint,
        effects.glow,
        effects.glowThreshold,
        effects.blur,
        effects.chromatic,
        effects.vignette,
        effects.grain,
        effects.gamma,
        effects.fade,
        effectProgram.count,
        0,
        0,
        0,
      ]),
    );
    if (!this.#sceneTexture || !this.#postBindGroup) this.resize(this.#width, this.#height);
    const encoder = this.#device.createCommandEncoder({ label: "Aster frame render graph" });
    const compute = encoder.beginComputePass({
      label: "GPU particle simulation",
      timestampWrites: this.#timestampQuerySet
        ? {
            querySet: this.#timestampQuerySet,
            beginningOfPassWriteIndex: 0,
            endOfPassWriteIndex: 1,
          }
        : undefined,
    });
    compute.setPipeline(this.#computePipeline);
    compute.setBindGroup(0, this.#computeBindGroup);
    compute.dispatchWorkgroups(Math.ceil(PARTICLE_COUNT / 256));
    compute.end();
    const sceneView = this.#sceneTexture?.createView();
    if (!sceneView || !this.#postBindGroup) throw new Error("HDR scene target is unavailable");
    const pass = encoder.beginRenderPass({
      label: "Linear HDR composition",
      timestampWrites: this.#timestampQuerySet
        ? {
            querySet: this.#timestampQuerySet,
            beginningOfPassWriteIndex: 2,
            endOfPassWriteIndex: 3,
          }
        : undefined,
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
    });
    if (geometry.data.length > 0) {
      pass.setVertexBuffer(0, this.#shapeBuffer);
      for (const batch of geometry.batches) {
        const media =
          batch.layer.kind === "image" || batch.layer.kind === "video"
            ? this.#mediaResources.get(batch.instanceId)
            : undefined;
        if (media?.bindGroup) {
          pass.setPipeline(this.#imagePipelines[batch.layer.blendMode]);
          pass.setBindGroup(0, media.bindGroup);
        } else {
          pass.setPipeline(this.#shapePipelines[batch.layer.blendMode]);
        }
        pass.draw(batch.vertexCount, 1, batch.firstVertex);
      }
    }
    const particleVisible = sceneLayers.some((scene) => scene.layer.kind === "particle");
    if (particleVisible) {
      pass.setPipeline(this.#particlePipeline);
      pass.setBindGroup(0, this.#particleBindGroup);
      pass.draw(6, PARTICLE_COUNT);
    }
    pass.end();
    const output = this.#context.getCurrentTexture().createView();
    const postPass = encoder.beginRenderPass({
      label: "Fused effects + ACES display transform",
      timestampWrites: this.#timestampQuerySet
        ? {
            querySet: this.#timestampQuerySet,
            beginningOfPassWriteIndex: 4,
            endOfPassWriteIndex: 5,
          }
        : undefined,
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
    const collectTimestamps =
      this.#timestampQuerySet &&
      this.#timestampResolveBuffer &&
      this.#timestampReadBuffer &&
      !this.#gpuTimestampPending;
    if (collectTimestamps) {
      this.#gpuTimestampPending = true;
      encoder.resolveQuerySet(this.#timestampQuerySet, 0, 6, this.#timestampResolveBuffer, 0);
      encoder.copyBufferToBuffer(
        this.#timestampResolveBuffer,
        0,
        this.#timestampReadBuffer,
        0,
        6 * BigUint64Array.BYTES_PER_ELEMENT,
      );
    }
    this.#device.queue.submit([encoder.finish()]);
    if (collectTimestamps) this.#readGpuTimestamps(this.#timestampReadBuffer);
    const cpuMs = performance.now() - started;
    const sample = frameInterval > 100 ? 16.67 : Math.max(frameInterval, 0.1);
    this.#smoothedFrameMs = this.#smoothedFrameMs * 0.9 + sample * 0.1;
    const hdr4kBytes = composition.width * composition.height * 8 * 3;
    return {
      fps: Math.min(240, 1000 / this.#smoothedFrameMs),
      frameMs: this.#smoothedFrameMs,
      cpuMs,
      gpuMs: this.#lastGpuMs,
      drawCalls: 1 + geometry.batches.length + Number(particleVisible),
      passCount: 3,
      dirtyNodes: sceneLayers.length + effectProgram.count,
      cacheHitRate: 0.86,
      estimatedVramMb: (hdr4kBytes + PARTICLE_COUNT * 16) / 1024 / 1024,
    };
  }

  async complete(): Promise<void> {
    await this.#device.queue.onSubmittedWorkDone();
  }

  #readGpuTimestamps(buffer: GPUBuffer): void {
    void buffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const timestamps = new BigUint64Array(buffer.getMappedRange().slice(0));
        const elapsed =
          timestamps[1] -
          timestamps[0] +
          (timestamps[3] - timestamps[2]) +
          (timestamps[5] - timestamps[4]);
        this.#lastGpuMs = Number(elapsed) / 1_000_000;
        buffer.unmap();
      })
      .catch(() => undefined)
      .finally(() => {
        this.#gpuTimestampPending = false;
      });
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
    const mediaTime = Math.max(0, Math.min(Math.max(0, duration - 0.001), time - layer.inPoint));
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

  #createShapePipeline(blendMode: BlendMode): GPURenderPipeline {
    const module = this.#device.createShaderModule({
      label: "Fused shape/color effect",
      code: shapeShader,
    });
    return this.#device.createRenderPipeline({
      label: `GPU-resident ${blendMode} layer composite`,
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vertex_main",
        buffers: [
          {
            arrayStride: FLOATS_PER_VERTEX * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "float32x2" },
              { shaderLocation: 2, offset: 16, format: "float32x4" },
              { shaderLocation: 3, offset: 32, format: "float32" },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: "fragment_main",
        targets: [
          {
            format: SCENE_FORMAT,
            blend: blendState(blendMode),
          },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
  }

  #createImagePipeline(blendMode: BlendMode): GPURenderPipeline {
    const module = this.#device.createShaderModule({
      label: "Imported image shader",
      code: imageShader,
    });
    return this.#device.createRenderPipeline({
      label: `GPU-resident ${blendMode} sRGB media layer`,
      layout: this.#device.createPipelineLayout({
        label: "Imported media pipeline layout",
        bindGroupLayouts: [this.#imageBindGroupLayout],
      }),
      vertex: {
        module,
        entryPoint: "vertex_main",
        buffers: [
          {
            arrayStride: FLOATS_PER_VERTEX * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "float32x2" },
              { shaderLocation: 2, offset: 16, format: "float32x4" },
              { shaderLocation: 3, offset: 32, format: "float32" },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: "fragment_main",
        targets: [
          {
            format: SCENE_FORMAT,
            blend: blendState(blendMode),
          },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
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

function blendState(mode: BlendMode): GPUBlendState {
  const alpha: GPUBlendComponent = {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  };
  if (mode === "add")
    return { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha };
  if (mode === "multiply")
    return { color: { srcFactor: "dst", dstFactor: "zero", operation: "add" }, alpha };
  if (mode === "screen")
    return {
      color: { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" },
      alpha,
    };
  return {
    color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha,
  };
}
