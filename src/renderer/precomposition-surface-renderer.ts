import { sourceForLayer, sourceLocator } from "../core/footage-source";
import { evaluateLayerSourceTime } from "../core/layer-time";
import { type FlattenedSceneLayer, flattenSceneLayers } from "../core/scene-evaluation";
import type { BlendMode, Composition, Project } from "../core/types";
import { gpuBlendState } from "./blend-state";
import { buildSceneGeometry, FLOATS_PER_VERTEX, type GeometryBatch } from "./geometry";
import { LayerEffectRenderer } from "./layer-effects";
import type { MediaTextureCache } from "./media-texture-cache";
import {
  createPrecompositionSurfaceBudget,
  MAX_PRECOMPOSITION_SURFACE_BYTES,
  MAX_PRECOMPOSITION_SURFACES,
  planPrecompositionSurface,
  precompositionSurfaceCacheKey,
} from "./precomposition-surface-plan";
import { planSceneRenderStack } from "./render-stack";
import { evaluateSceneCamera } from "./scene-camera";
import type { PreparedSceneGenerator, SceneGeneratorHost } from "./scene-generator-host";
import { buildSceneLighting, SCENE_LIGHTING_BYTES } from "./scene-lighting";
import { IMAGE_VERTEX_BUFFERS } from "./scene-pipelines";
import { planTextMotionBlurFrame, type TextMotionBlurPlan } from "./text-motion-blur-plan";

const SURFACE_FORMAT: GPUTextureFormat = "rgba16float";
const INITIAL_VERTEX_BYTES = 6 * FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT;
const CACHE_RETENTION_FRAMES = 2;

interface SurfaceEntry {
  key: string;
  width: number;
  height: number;
  color: GPUTexture;
  depth: GPUTexture;
  bindGroup: GPUBindGroup;
  vertexBuffer: GPUBuffer;
  vertexBufferBytes: number;
  lightingBuffer: GPUBuffer;
  lightingBindGroup: GPUBindGroup;
  effects?: LayerEffectRenderer;
  estimatedBytes: number;
  textureCount: number;
  lastUsedFrame: number;
}

interface SurfaceJob {
  entry: SurfaceEntry;
  composition: Composition;
  time: number;
  sceneLayers: FlattenedSceneLayer[];
  geometry: ReturnType<typeof buildSceneGeometry>;
  generators: PreparedSceneGenerator[];
}

export interface PrecompositionSurfaceFrame {
  diagnostics: string[];
  estimatedBytes: number;
  residentBytes: number;
  residentTextureCount: number;
  textureCount: number;
  surfaceCount: number;
  mediaInstanceIds: ReadonlySet<string>;
}

interface SurfaceRendererOptions {
  mediaTextures: MediaTextureCache;
  mediaLayout: GPUBindGroupLayout;
  mediaSampler: GPUSampler;
  lightingLayout: GPUBindGroupLayout;
  shapePipelines: Record<BlendMode, GPURenderPipeline>;
  imagePipelines: Record<BlendMode, GPURenderPipeline>;
  sceneGenerators?: SceneGeneratorHost;
}

/**
 * Owns bounded, time-addressed GPU render targets for 3D precomposition
 * surfaces. Source compositions are encoded in dependency order and never read
 * back to the CPU.
 */
export class PrecompositionSurfaceRenderer {
  readonly #device: GPUDevice;
  readonly #mediaTextures: MediaTextureCache;
  readonly #mediaLayout: GPUBindGroupLayout;
  readonly #mediaSampler: GPUSampler;
  readonly #lightingLayout: GPUBindGroupLayout;
  readonly #shapePipelines: Record<BlendMode, GPURenderPipeline>;
  readonly #imagePipelines: Record<BlendMode, GPURenderPipeline>;
  readonly #sceneGenerators?: SceneGeneratorHost;
  readonly #surfacePipelines: Record<BlendMode, GPURenderPipeline>;
  readonly #shadowTexture: GPUTexture;
  readonly #shadowSampler: GPUSampler;
  readonly #entries = new Map<string, SurfaceEntry>();
  readonly #bindings = new Map<string, GPUBindGroup>();
  readonly #mediaInstanceIds = new Set<string>();
  #jobs: SurfaceJob[] = [];
  #project?: Project;
  #revision = 0;
  #frame = 0;
  #frameStats: PrecompositionSurfaceFrame = emptyFrame();

  constructor(device: GPUDevice, options: SurfaceRendererOptions) {
    this.#device = device;
    this.#mediaTextures = options.mediaTextures;
    this.#mediaLayout = options.mediaLayout;
    this.#mediaSampler = options.mediaSampler;
    this.#lightingLayout = options.lightingLayout;
    this.#shapePipelines = options.shapePipelines;
    this.#imagePipelines = options.imagePipelines;
    this.#sceneGenerators = options.sceneGenerators;
    this.#surfacePipelines = createSurfacePipelines(device, options.mediaLayout);
    this.#shadowTexture = device.createTexture({
      label: "Precomposition surface unshadowed depth",
      size: [1, 1],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#shadowSampler = device.createSampler({
      label: "Precomposition surface shadow comparison",
      compare: "less-equal",
    });
  }

  prepare(
    project: Project | undefined,
    sceneLayers: readonly FlattenedSceneLayer[],
    playing: boolean,
    memoryBudgetMb?: number,
    enableTextMotionBlur = true,
  ): PrecompositionSurfaceFrame {
    this.#frame += 1;
    if (this.#project !== project) {
      for (const entry of this.#entries.values()) destroyEntry(entry);
      this.#entries.clear();
      this.#project = project;
      this.#revision += 1;
    }
    this.#jobs = [];
    this.#bindings.clear();
    this.#mediaInstanceIds.clear();
    const diagnostics: string[] = [];
    const budget = createPrecompositionSurfaceBudget();
    const preparedKeys = new Set<string>();
    const preparedSources = new Map<string, SurfaceEntry>();
    if (project) {
      for (const scene of sceneLayers) {
        if (!scene.precompositionSurface) continue;
        this.#prepareSurface(
          scene,
          project,
          playing,
          memoryBudgetMb,
          budget,
          preparedKeys,
          preparedSources,
          diagnostics,
          enableTextMotionBlur,
        );
      }
    }
    this.#sweep(preparedKeys);
    this.#frameStats = {
      diagnostics,
      estimatedBytes: budget.bytes,
      residentBytes: this.#residentBytes(),
      residentTextureCount: this.#residentTextureCount(),
      textureCount: budget.textures,
      surfaceCount: budget.surfaces,
      mediaInstanceIds: new Set(this.#mediaInstanceIds),
    };
    return this.#frameStats;
  }

  encode(encoder: GPUCommandEncoder): void {
    for (const job of this.#jobs) this.#encodeJob(encoder, job);
  }

  bindingFor(instanceId: string): GPUBindGroup | undefined {
    return this.#bindings.get(instanceId);
  }

  pipelineFor(blendMode: BlendMode): GPURenderPipeline {
    return this.#surfacePipelines[blendMode];
  }

  get estimatedBytes(): number {
    return this.#frameStats.estimatedBytes;
  }

  get textureCount(): number {
    return this.#frameStats.textureCount;
  }

  destroy(): void {
    for (const entry of this.#entries.values()) destroyEntry(entry);
    this.#entries.clear();
    this.#bindings.clear();
    this.#jobs = [];
    this.#shadowTexture.destroy();
  }

  #prepareSurface(
    scene: FlattenedSceneLayer,
    project: Project,
    playing: boolean,
    memoryBudgetMb: number | undefined,
    budget: ReturnType<typeof createPrecompositionSurfaceBudget>,
    preparedKeys: Set<string>,
    preparedSources: Map<string, SurfaceEntry>,
    diagnostics: string[],
    enableTextMotionBlur: boolean,
  ): void {
    const surface = scene.precompositionSurface;
    if (!surface) return;
    const logicalKey = `${this.#revision}:${surface.composition.id}:${surface.time.toFixed(9)}`;
    const shared = preparedSources.get(logicalKey);
    if (shared) {
      shared.lastUsedFrame = this.#frame;
      this.#bindings.set(scene.instanceId, shared.bindGroup);
      return;
    }
    let childLayers: FlattenedSceneLayer[];
    try {
      childLayers = namespaceSurfaceLayers(
        flattenSceneLayers(surface.composition, project, surface.time),
        scene.resourceInstanceId,
        surface.compositionPath,
      );
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
      return;
    }
    const hasEffects = childLayers.some(
      (child) =>
        child.layer.kind === "adjustment" || child.layer.effects.some((effect) => effect.enabled),
    );
    const plan = planPrecompositionSurface(
      {
        scene,
        deviceMaxTextureDimension: this.#device.limits.maxTextureDimension2D,
        memoryBudgetMb,
        hasEffects,
      },
      budget,
    );
    if (plan.diagnostic) diagnostics.push(plan.diagnostic);
    if (plan.status === "skipped") return;
    const key = precompositionSurfaceCacheKey(scene, this.#revision, plan.width, plan.height);
    const existing = this.#entries.get(key);
    const entry =
      existing ??
      this.#reuseEntry(key, plan.width, plan.height, hasEffects) ??
      this.#createEntry(key, plan.width, plan.height, plan.estimatedBytes, plan.textureCount);
    if (!this.#entries.has(key)) this.#entries.set(key, entry);
    entry.lastUsedFrame = this.#frame;
    preparedSources.set(logicalKey, entry);
    if (hasEffects && !entry.effects) {
      entry.effects = new LayerEffectRenderer(this.#device, SURFACE_FORMAT);
      entry.effects.resize(entry.width, entry.height);
    }
    this.#bindings.set(scene.instanceId, entry.bindGroup);
    if (preparedKeys.has(key)) return;
    preparedKeys.add(key);

    const resolutionScale = Math.max(
      entry.width / Math.max(1, surface.composition.width),
      entry.height / Math.max(1, surface.composition.height),
    );
    const textMotionBlur = enableTextMotionBlur
      ? planTextMotionBlurFrame({
          composition: surface.composition,
          project,
          frameTime: surface.time,
          sceneLayers: childLayers,
          resolutionScale,
          evaluateSceneLayers: (sampleTime) =>
            namespaceSurfaceLayers(
              flattenSceneLayers(surface.composition, project, sampleTime),
              scene.resourceInstanceId,
              surface.compositionPath,
            ),
        })
      : {
          sampleCount: 0,
          plans: new Map(),
          exposureSceneLayers: [],
          renderSceneLayers: childLayers,
        };
    childLayers = [...textMotionBlur.renderSceneLayers];
    for (const child of childLayers) {
      this.#prepareMedia(
        child,
        playing,
        resolutionScale,
        textMotionBlur.plans.get(child.resourceInstanceId),
      );
      if (child.precompositionSurface)
        this.#prepareSurface(
          child,
          project,
          playing,
          memoryBudgetMb,
          budget,
          preparedKeys,
          preparedSources,
          diagnostics,
          enableTextMotionBlur,
        );
    }
    const camera = evaluateSceneCamera(surface.composition, surface.time);
    const geometry = buildSceneGeometry(surface.composition, childLayers, camera);
    if (
      surface.composition.environment?.enabled &&
      geometry.batches.some((batch) => batch.layer.kind === "mesh")
    )
      diagnostics.push(
        `${surface.composition.name}: HDR environment lighting is not sampled inside precomposition surfaces`,
      );
    if (
      geometry.batches.some(
        (batch) => batch.layer.kind === "mesh" && batch.layer.mesh?.materialTextures?.normal,
      )
    )
      diagnostics.push(
        `${surface.composition.name}: mesh normal maps are not sampled inside precomposition surfaces`,
      );
    if (
      childLayers.some(
        (child) => child.layer.kind === "light" && child.layer.light?.shadowQuality !== "off",
      ) &&
      geometry.batches.some((batch) => batch.layer.threeDimensional)
    )
      diagnostics.push(
        `${surface.composition.name}: child shadow maps are not encoded inside precomposition surfaces`,
      );
    this.#ensureVertexBuffer(entry, geometry.data.byteLength);
    if (geometry.data.byteLength > 0)
      this.#device.queue.writeBuffer(entry.vertexBuffer, 0, geometry.data);
    const cameraPosition = camera?.pose.position;
    this.#device.queue.writeBuffer(
      entry.lightingBuffer,
      0,
      buildSceneLighting(childLayers, surface.composition, false, cameraPosition),
    );
    this.#jobs.push({
      entry,
      composition: surface.composition,
      time: surface.time,
      sceneLayers: childLayers,
      geometry,
      generators: this.#sceneGenerators
        ? childLayers
            .filter((child) => this.#sceneGenerators?.supports(child))
            .map((child) =>
              this.#sceneGenerators?.prepare(
                child,
                surface.composition,
                entry.width,
                entry.height,
                memoryBudgetMb,
                camera,
              ),
            )
            .filter((generator): generator is PreparedSceneGenerator => Boolean(generator))
        : [],
    });
  }

  #prepareMedia(
    scene: FlattenedSceneLayer,
    playing: boolean,
    resolutionScale: number,
    textMotionBlur?: TextMotionBlurPlan,
  ): void {
    if (scene.layer.kind === "text") {
      this.#mediaTextures.prepareText(
        scene.layer,
        scene.resourceInstanceId,
        evaluateLayerSourceTime(scene.layer, scene.localTime),
        scene.sourceComposition.frameRate.numerator / scene.sourceComposition.frameRate.denominator,
        resolutionScale,
        textMotionBlur,
      );
      this.#mediaInstanceIds.add(scene.resourceInstanceId);
      return;
    }
    if (
      (scene.layer.kind === "image" || scene.layer.kind === "video") &&
      sourceLocator(sourceForLayer(this.#project, scene.layer))
    ) {
      const footage = sourceForLayer(this.#project, scene.layer);
      if (!footage) return;
      this.#mediaTextures.prepareMedia(
        scene.layer,
        footage,
        scene.localTime,
        playing,
        scene.resourceInstanceId,
      );
      this.#mediaInstanceIds.add(scene.resourceInstanceId);
    }
  }

  #createEntry(
    key: string,
    width: number,
    height: number,
    estimatedBytes: number,
    textureCount: number,
  ): SurfaceEntry {
    while (
      this.#entries.size >= MAX_PRECOMPOSITION_SURFACES ||
      this.#residentBytes() + estimatedBytes > MAX_PRECOMPOSITION_SURFACE_BYTES
    )
      this.#evictOldest();
    const color = this.#device.createTexture({
      label: `Precomposition HDR surface · ${key}`,
      size: [width, height],
      format: SURFACE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    const depth = this.#device.createTexture({
      label: `Precomposition depth surface · ${key}`,
      size: [width, height],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const vertexBuffer = this.#device.createBuffer({
      label: `Precomposition geometry · ${key}`,
      size: INITIAL_VERTEX_BYTES,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const lightingBuffer = this.#device.createBuffer({
      label: `Precomposition lighting · ${key}`,
      size: SCENE_LIGHTING_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    return {
      key,
      width,
      height,
      color,
      depth,
      bindGroup: this.#device.createBindGroup({
        label: `Precomposition sampler · ${key}`,
        layout: this.#mediaLayout,
        entries: [
          { binding: 0, resource: color.createView() },
          { binding: 1, resource: this.#mediaSampler },
        ],
      }),
      vertexBuffer,
      vertexBufferBytes: INITIAL_VERTEX_BYTES,
      lightingBuffer,
      lightingBindGroup: this.#device.createBindGroup({
        label: `Precomposition lighting resources · ${key}`,
        layout: this.#lightingLayout,
        entries: [
          { binding: 0, resource: { buffer: lightingBuffer } },
          { binding: 1, resource: this.#shadowTexture.createView() },
          { binding: 2, resource: this.#shadowSampler },
        ],
      }),
      estimatedBytes,
      textureCount,
      lastUsedFrame: this.#frame,
    };
  }

  #reuseEntry(
    key: string,
    width: number,
    height: number,
    hasEffects: boolean,
  ): SurfaceEntry | undefined {
    const reusable = [...this.#entries.values()]
      .filter(
        (entry) =>
          entry.lastUsedFrame !== this.#frame &&
          entry.width === width &&
          entry.height === height &&
          Boolean(entry.effects) === hasEffects,
      )
      .sort((left, right) => left.lastUsedFrame - right.lastUsedFrame)[0];
    if (!reusable) return undefined;
    this.#entries.delete(reusable.key);
    reusable.key = key;
    this.#entries.set(key, reusable);
    return reusable;
  }

  #ensureVertexBuffer(entry: SurfaceEntry, requiredBytes: number): void {
    if (requiredBytes <= entry.vertexBufferBytes) return;
    const size = 2 ** Math.ceil(Math.log2(requiredBytes));
    entry.vertexBuffer.destroy();
    entry.vertexBuffer = this.#device.createBuffer({
      label: `Precomposition geometry · ${entry.key} · grown`,
      size,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    entry.vertexBufferBytes = size;
  }

  #encodeJob(encoder: GPUCommandEncoder, job: SurfaceJob): void {
    const { entry, composition, geometry, sceneLayers, time, generators } = job;
    if (generators.length > 0) {
      const compute = encoder.beginComputePass({
        label: `Precomposition scene generators · ${composition.name}`,
      });
      for (const generator of generators) this.#sceneGenerators?.encodeCompute(compute, generator);
      compute.end();
    }
    const generatorByInstance = new Map(
      generators.map((generator) => [generator.instanceId, generator]),
    );
    const stack = planSceneRenderStack(sceneLayers, geometry.batches);
    let pass: GPURenderPassEncoder | undefined = this.#beginPass(encoder, entry, composition);
    const activeEffects = new Set<string>();
    for (const item of stack) {
      if (item.kind === "generator") {
        const generator = generatorByInstance.get(item.scene.instanceId);
        if (!generator) continue;
        if (item.scene.layer.effects.some((effect) => effect.enabled)) {
          pass?.end();
          pass = undefined;
          activeEffects.add(item.scene.instanceId);
          entry.effects?.encode(
            encoder,
            entry.color.createView(),
            composition,
            item.scene.layer,
            item.scene.instanceId,
            time,
            (layerPass) => this.#sceneGenerators?.draw(layerPass, generator),
          );
          continue;
        }
        pass ??= this.#resumePass(encoder, entry);
        this.#sceneGenerators?.draw(pass, generator);
        continue;
      }
      if (item.kind === "adjustment") {
        if (!item.scene.layer.effects.some((effect) => effect.enabled)) continue;
        pass?.end();
        pass = undefined;
        const count = entry.effects?.encodeAdjustment(
          encoder,
          entry.color,
          composition,
          item.scene.layer,
          item.scene.instanceId,
          time,
        );
        if (count) activeEffects.add(item.scene.instanceId);
        continue;
      }
      const { batch } = item;
      if (batch.layer.effects.some((effect) => effect.enabled)) {
        pass?.end();
        pass = undefined;
        activeEffects.add(batch.instanceId);
        entry.effects?.encode(
          encoder,
          entry.color.createView(),
          composition,
          batch.layer,
          batch.instanceId,
          time,
          (layerPass) => this.#drawBatch(layerPass, entry, batch),
        );
        continue;
      }
      pass ??= this.#resumePass(encoder, entry);
      this.#drawBatch(pass, entry, batch);
    }
    pass?.end();
    entry.effects?.sweep(activeEffects);
  }

  #beginPass(
    encoder: GPUCommandEncoder,
    entry: SurfaceEntry,
    composition: Composition,
  ): GPURenderPassEncoder {
    return encoder.beginRenderPass({
      label: `Isolated precomposition · ${composition.name}`,
      colorAttachments: [
        {
          view: entry.color.createView(),
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
        view: entry.depth.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
  }

  #resumePass(encoder: GPUCommandEncoder, entry: SurfaceEntry): GPURenderPassEncoder {
    return encoder.beginRenderPass({
      label: "Resume isolated precomposition stack",
      colorAttachments: [{ view: entry.color.createView(), loadOp: "load", storeOp: "store" }],
      depthStencilAttachment: {
        view: entry.depth.createView(),
        depthLoadOp: "load",
        depthStoreOp: "store",
      },
    });
  }

  #drawBatch(pass: GPURenderPassEncoder, entry: SurfaceEntry, batch: GeometryBatch): void {
    pass.setVertexBuffer(0, entry.vertexBuffer);
    const surface =
      batch.layer.kind === "precomposition" ? this.#bindings.get(batch.instanceId) : undefined;
    if (surface) {
      pass.setPipeline(this.#surfacePipelines[batch.layer.blendMode]);
      pass.setBindGroup(0, surface);
    } else {
      const media =
        batch.layer.kind === "image" || batch.layer.kind === "video" || batch.layer.kind === "text"
          ? this.#mediaTextures.bindGroup(batch.resourceInstanceId)
          : undefined;
      if (batch.layer.kind === "precomposition" && !media) return;
      if (media) {
        pass.setPipeline(this.#imagePipelines[batch.layer.blendMode]);
        pass.setBindGroup(0, media);
      } else {
        pass.setPipeline(this.#shapePipelines[batch.layer.blendMode]);
        pass.setBindGroup(0, entry.lightingBindGroup);
      }
    }
    pass.draw(batch.vertexCount, 1, batch.firstVertex);
  }

  #sweep(activeKeys: ReadonlySet<string>): void {
    for (const [key, entry] of this.#entries) {
      if (activeKeys.has(key) || this.#frame - entry.lastUsedFrame <= CACHE_RETENTION_FRAMES)
        continue;
      destroyEntry(entry);
      this.#entries.delete(key);
    }
  }

  #evictOldest(): void {
    const oldest = [...this.#entries.values()].sort(
      (left, right) => left.lastUsedFrame - right.lastUsedFrame,
    )[0];
    if (!oldest) return;
    destroyEntry(oldest);
    this.#entries.delete(oldest.key);
  }

  #residentBytes(): number {
    return [...this.#entries.values()].reduce((total, entry) => total + entry.estimatedBytes, 0);
  }

  #residentTextureCount(): number {
    return [...this.#entries.values()].reduce((total, entry) => total + entry.textureCount, 0);
  }
}

function createSurfacePipelines(
  device: GPUDevice,
  mediaLayout: GPUBindGroupLayout,
): Record<BlendMode, GPURenderPipeline> {
  const module = device.createShaderModule({
    label: "Premultiplied precomposition surface shader",
    code: precompositionSurfaceShader,
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [mediaLayout] });
  return Object.fromEntries(
    (["normal", "add", "multiply", "screen", "overlay"] as const).map((blendMode) => [
      blendMode,
      device.createRenderPipeline({
        label: `Precomposition 3D surface · ${blendMode}`,
        layout,
        vertex: { module, entryPoint: "vertex_main", buffers: IMAGE_VERTEX_BUFFERS },
        fragment: {
          module,
          entryPoint: "fragment_main",
          targets: [{ format: SURFACE_FORMAT, blend: gpuBlendState(blendMode) }],
        },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: {
          format: "depth24plus",
          depthWriteEnabled: true,
          depthCompare: "less-equal",
        },
      }),
    ]),
  ) as Record<BlendMode, GPURenderPipeline>;
}

function destroyEntry(entry: SurfaceEntry): void {
  entry.effects?.destroy();
  entry.color.destroy();
  entry.depth.destroy();
  entry.vertexBuffer.destroy();
  entry.lightingBuffer.destroy();
}

function namespaceSurfaceLayers(
  layers: readonly FlattenedSceneLayer[],
  surfaceKey: string,
  compositionPath: readonly string[],
): FlattenedSceneLayer[] {
  return layers.map((child) => ({
    ...child,
    // Standalone evaluation starts every source at `root`. Namespace both identities by the stable
    // outer wrapper resource path: separate wrappers cannot overwrite each other, clones share,
    // and playback does not churn media resources merely because the sample time moved.
    instanceId: namespaceSurfaceChild(surfaceKey, child.instanceId),
    resourceInstanceId: namespaceSurfaceChild(surfaceKey, child.resourceInstanceId),
    precompositionSurface: child.precompositionSurface
      ? {
          ...child.precompositionSurface,
          compositionPath: [...compositionPath, ...child.precompositionSurface.compositionPath],
        }
      : undefined,
  }));
}

function namespaceSurfaceChild(surfaceKey: string, relativeId: string): string {
  return `surface:${surfaceKey}/${relativeId}`;
}

function emptyFrame(): PrecompositionSurfaceFrame {
  return {
    diagnostics: [],
    estimatedBytes: 0,
    residentBytes: 0,
    residentTextureCount: 0,
    textureCount: 0,
    surfaceCount: 0,
    mediaInstanceIds: new Set(),
  };
}

export const precompositionSurfaceShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
}
@group(0) @binding(0) var surface_texture: texture_2d<f32>;
@group(0) @binding(1) var surface_sampler: sampler;

@vertex fn vertex_main(
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position, 1.0);
  output.uv = uv;
  output.color = color;
  return output;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let sampled = textureSample(surface_texture, surface_sampler, input.uv);
  let alpha = sampled.a * input.color.a;
  if (alpha <= 0.00001) { discard; }
  return vec4f(
    sampled.rgb * input.color.rgb * input.color.a,
    alpha,
  );
}
`;
