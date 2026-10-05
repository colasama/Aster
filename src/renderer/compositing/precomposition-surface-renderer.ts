import { evaluateLayerSourceTime } from "../../core/animation/layer-time";
import { sourceForLayer } from "../../core/media/footage-source";
import type { FlattenedSceneLayer } from "../../core/scene/scene-evaluation";
import type { BlendMode, Composition, Project } from "../../core/types";
import { BLEND_MODES } from "../../core/types";
import { prepareLayerEffects } from "../effects/layer-effect-plan";
import { LayerEffectRenderer } from "../effects/layer-effects";
import { requirePlan } from "../frame-plan/canonical";
import { readGeneratorSlice } from "../frame-plan/generator-plan";
import { buildPrecompositionBundle } from "../frame-plan/precomposition-bundle-plan";
import { readPrecompositionBundle } from "../frame-plan/precomposition-bundle-read";
import type { BundleResource } from "../frame-plan/precomposition-bundle-resources";
import { buildPrecompositionGraph } from "../frame-plan/precomposition-graph-plan";
import { buildFrameHeader } from "../frame-plan/root-post-plan";
import { prepareSceneBuffers } from "../frame-plan/scene-buffer-upload";
import type { FramePlanSliceData, PutResource } from "../frame-plan/types";
import { FLOATS_PER_VERTEX } from "../geometry/geometry";
import { sharedShaders } from "../gpu/shared-shader-catalog";
import { LutSelectionPlanner } from "../media/lut-selection-plan";
import type { MediaTextureCache } from "../media/media-texture-cache";
import type { PreparedSceneGenerator, SceneGeneratorHost } from "../scene/scene-generator-host";
import { constrainGeneratorPlan, type SceneGeneratorPlan } from "../scene/scene-generator-plan";
import { SCENE_LIGHTING_BYTES } from "../scene/scene-lighting";
import { IMAGE_VERTEX_BUFFERS } from "../scene/scene-pipelines";
import type { TextMotionBlurPlan } from "../text/text-motion-blur-plan";
import { transformedTextRasterScale } from "../text/text-rasterizer";
import { FIXED_BLEND_MODES, gpuBlendState } from "./blend-state";
import { executePrecompositionScene } from "./execute-precomposition-scene";
import {
  bindPrecompositionSceneMedia,
  type PrecompositionMediaBindings,
} from "./precomposition-scene-media";
import {
  buildPrecompositionScenePlan,
  type PrecompositionSceneInputs,
  type PrecompositionScenePlan,
  type PrecompositionTarget,
} from "./precomposition-scene-plan";
import {
  type EvaluatedPrecompositionSource,
  evaluatePrecompositionGeometry,
  evaluatePrecompositionSources,
} from "./precomposition-source-evaluation";
import {
  MAX_PRECOMPOSITION_SURFACE_TEXTURES,
  MAX_PRECOMPOSITION_SURFACES,
  precompositionSurfaceByteLimit,
} from "./precomposition-surface-plan";

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

export interface PrecompositionSurfaceFrame {
  diagnostics: string[];
  estimatedBytes: number;
  residentBytes: number;
  residentTextureCount: number;
  textureCount: number;
  surfaceCount: number;
  mediaInstanceIds: ReadonlySet<string>;
}

export interface PrecompositionBundle {
  plan: FramePlanSliceData;
  resources: readonly BundleResource[];
}
interface PrecompositionBundleMedia extends PrecompositionMediaBindings {
  hashFor(instanceId: string): string | null;
  resourceMessages: readonly PutResource[];
}

interface SurfaceRendererOptions {
  mediaTextures?: MediaTextureCache;
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
  readonly #directEffectPlanner = new LutSelectionPlanner();
  readonly #device: GPUDevice;
  readonly #mediaTextures?: MediaTextureCache;
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
  readonly #bindings = new Map<string, string>();
  readonly #generators = new Map<string, PreparedSceneGenerator | null>();
  readonly #mediaInstanceIds = new Set<string>();
  #jobs: PrecompositionSceneInputs[] = [];
  #project?: Project;
  #revision = 0;
  #frame = 0;
  #byteLimit = precompositionSurfaceByteLimit();
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
    renderScale = 1,
  ): PrecompositionSurfaceFrame {
    requirePlan(
      this.#mediaTextures,
      "missing_resource",
      "Source preparation requires a media cache",
    );
    this.#frame += 1;
    this.#byteLimit = precompositionSurfaceByteLimit(memoryBudgetMb, renderScale);
    if (this.#project !== project) {
      for (const entry of this.#entries.values()) destroyEntry(entry);
      this.#entries.clear();
      this.#project = project;
      this.#revision += 1;
    }
    this.#jobs = [];
    this.#generators.clear();
    this.#bindings.clear();
    this.#mediaInstanceIds.clear();
    const evaluation = evaluatePrecompositionSources({
      project,
      sceneLayers,
      revision: this.#revision,
      maxTextureDimension: this.#device.limits.maxTextureDimension2D,
      memoryBudgetMb,
      enableTextMotionBlur,
      renderScale,
    });
    const { diagnostics, budget } = evaluation;
    this.#pinTargets(
      evaluation.operations.flatMap((op) => (op.kind === "target" ? [op.target] : [])),
    );
    for (const [id, target] of evaluation.bindings) this.#bindings.set(id, target);
    for (const operation of evaluation.operations) {
      switch (operation.kind) {
        case "target":
          this.#prepareTarget(operation.target);
          break;
        case "media":
          this.#prepareMedia(
            operation.scene,
            playing,
            operation.resolutionScale,
            operation.textMotionBlur,
          );
          break;
        case "scene":
          this.#prepareScene(operation.source, memoryBudgetMb, diagnostics);
          break;
      }
    }
    this.#sweep(evaluation.activeKeys);
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

  planScenes(media: PrecompositionBundleMedia): PrecompositionScenePlan[] {
    const bundle = this.buildBundle(media);
    return bundle
      ? this.#realizeBundle(readPrecompositionBundle(bundle.plan, bundle.resources))
      : [];
  }

  /** Captures owned transport data without realizing generators or uploading scene buffers. */
  buildBundle(media: PrecompositionBundleMedia): PrecompositionBundle | undefined {
    if (this.#jobs.length === 0) return undefined;
    const scenes = this.#jobs.map((job) => bindPrecompositionSceneMedia(job, media));
    return this.serializeScenes(scenes, media);
  }

  serializeScenes(
    scenes: readonly PrecompositionScenePlan[],
    media: PrecompositionBundleMedia,
  ): PrecompositionBundle | undefined {
    if (scenes.length === 0) return undefined;
    const graph = buildPrecompositionGraph(
      scenes[0].scene.metadata.header,
      scenes.map((scene) => ({
        target: scene.target,
        drawTargets: scene.draws.map((draw) =>
          draw.texture.kind === "surface" ? draw.texture.targetId : undefined,
        ),
      })),
      this.#bindings,
    );
    return buildPrecompositionBundle(graph, scenes, media.resourceMessages);
  }

  /** Executes supplied transport data without source evaluation or an authoring media cache. */
  prepareBundle(
    bundle: PrecompositionBundle,
    options: { memoryBudgetMb?: number; renderScale?: number } = {},
  ): PrecompositionScenePlan[] {
    const decoded = readPrecompositionBundle(bundle.plan, bundle.resources);
    const targets = decoded.graph.nodes.map((node) => node.target);
    const byteLimit = precompositionSurfaceByteLimit(options.memoryBudgetMb, options.renderScale);
    requirePlan(
      targets.reduce((sum, target) => sum + target.estimatedBytes, 0) <= byteLimit &&
        targets.every(
          (target) =>
            target.width <= this.#device.limits.maxTextureDimension2D &&
            target.height <= this.#device.limits.maxTextureDimension2D,
        ),
      "limit_exceeded",
      "Supplied precomposition targets exceed device or memory limits",
    );
    for (const target of targets) {
      const entry = this.#entries.get(target.id);
      requirePlan(
        !entry ||
          (entry.width === target.width &&
            entry.height === target.height &&
            entry.estimatedBytes === target.estimatedBytes &&
            entry.textureCount === target.textureCount),
        "invalid_precomposition",
        "Supplied target identity changed its allocation descriptor",
      );
    }
    requirePlan(
      this.#sceneGenerators ||
        decoded.plans.every((plan) =>
          plan.generators.every((generator) => generator.execution?.status === "unavailable"),
        ),
      "missing_resource",
      "Supplied generators require an execution host",
    );
    this.#frame += 1;
    this.#byteLimit = byteLimit;
    this.#jobs = [];
    this.#mediaInstanceIds.clear();
    this.#pinTargets(targets);
    for (const target of targets) this.#prepareTarget(target);
    this.#sweep(new Set(targets.map((target) => target.id)));
    const plans = this.#realizeBundle(decoded);
    this.#frameStats = {
      diagnostics: [],
      estimatedBytes: targets.reduce((sum, target) => sum + target.estimatedBytes, 0),
      textureCount: targets.reduce((sum, target) => sum + target.textureCount, 0),
      surfaceCount: targets.length,
      residentBytes: this.#residentBytes(),
      residentTextureCount: this.#residentTextureCount(),
      mediaInstanceIds: new Set(),
    };
    return plans;
  }

  #pinTargets(targets: readonly PrecompositionTarget[]): void {
    // Pin the complete frame before a new target can recycle an unvisited retained entry.
    for (const target of targets) {
      const entry = this.#entries.get(target.id);
      if (entry) entry.lastUsedFrame = this.#frame;
    }
  }

  #realizeBundle(decoded: ReturnType<typeof readPrecompositionBundle>): PrecompositionScenePlan[] {
    this.#generators.clear();
    this.#bindings.clear();
    for (const [id, target] of decoded.graph.bindings) this.#bindings.set(id, target);
    for (const plan of decoded.plans) {
      const entry = this.#entries.get(plan.target.id);
      if (!entry) throw new Error("Decoded precomposition target is absent");
      this.#uploadScene(entry, plan);
      for (const generator of plan.generators) {
        if (generator.execution?.status === "unavailable") {
          this.#generators.set(generator.instanceId, null);
          continue;
        }
        if (!this.#sceneGenerators) throw new Error("Decoded generator host is absent");
        const invocation = readGeneratorSlice(
          generator.plan,
          new Map(generator.shaders.map((s) => [s.message.hash, s])),
        );
        const expected = generator.execution;
        const prepared = this.#sceneGenerators.preparePlanned(
          expected?.status === "ready"
            ? constrainGeneratorPlan(invocation, expected.capacity)
            : invocation,
          generator.origin,
        );
        requirePlan(
          expected?.status !== "ready" || prepared?.effectiveCount === expected.effective_count,
          "resource_generation_mismatch",
          "Captured generator execution cannot be reproduced",
        );
        generator.execution =
          expected?.status === "ready"
            ? expected
            : prepared
              ? {
                  status: "ready",
                  capacity: prepared.resources.capacity,
                  effective_count: prepared.effectiveCount,
                }
              : { status: "unavailable" };
        this.#generators.set(generator.instanceId, prepared ?? null);
      }
    }
    return decoded.plans;
  }

  encode(
    encoder: GPUCommandEncoder,
    plans: readonly PrecompositionScenePlan[],
    media: PrecompositionMediaBindings,
  ): void {
    for (const plan of plans) this.#encodeJob(encoder, plan, media);
  }

  bindingFor(instanceId: string): GPUBindGroup | undefined {
    const target = this.#bindings.get(instanceId);
    return target === undefined ? undefined : this.#entries.get(target)?.bindGroup;
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
    this.#generators.clear();
    this.#jobs = [];
    this.#shadowTexture.destroy();
  }

  #prepareTarget(target: PrecompositionTarget): void {
    const { id: key, width, height, hasEffects } = target;
    const entry =
      this.#entries.get(key) ??
      this.#reuseEntry(key, width, height, hasEffects) ??
      this.#createEntry(key, width, height, target.estimatedBytes, target.textureCount);
    if (!this.#entries.has(key)) this.#entries.set(key, entry);
    entry.lastUsedFrame = this.#frame;
    if (hasEffects && !entry.effects) {
      entry.effects = new LayerEffectRenderer(this.#device, SURFACE_FORMAT);
      entry.effects.resize(width, height);
    }
  }

  #prepareScene(
    source: EvaluatedPrecompositionSource,
    memoryBudgetMb: number | undefined,
    diagnostics: string[],
  ): void {
    const mediaTextures = this.#mediaTextures;
    requirePlan(mediaTextures, "missing_resource", "Source geometry requires a media cache");
    const { target } = source;
    const childLayers = [...source.layers];
    const entry = this.#entries.get(target.id);
    if (!entry) throw new Error("Evaluated precomposition target is absent");
    const {
      camera,
      geometry,
      lighting,
      diagnostics: sceneDiagnostics,
    } = evaluatePrecompositionGeometry(source, (id) => mediaTextures.textBounds(id));
    diagnostics.push(...sceneDiagnostics);
    const effects = this.#prepareEffects(entry, source.composition, childLayers, source.time);
    const generators: SceneGeneratorPlan[] = [];
    if (this.#sceneGenerators)
      for (const child of childLayers) {
        if (!this.#sceneGenerators.supports(child)) continue;
        const planned = this.#sceneGenerators.plan(
          child,
          source.composition,
          entry.width,
          entry.height,
          memoryBudgetMb,
          camera,
        );
        if (!planned) continue;
        generators.push(planned);
      }
    const job = buildPrecompositionScenePlan({
      target,
      revision: this.#revision,
      composition: source.composition,
      time: source.time,
      layers: childLayers,
      geometry,
      lighting,
      effects,
      generators,
      surfaceTargets: this.#bindings,
    });
    this.#jobs.push(job);
  }

  #uploadScene(entry: SurfaceEntry, plan: PrecompositionScenePlan): void {
    const buffers = prepareSceneBuffers(plan.scene);
    this.#ensureVertexBuffer(entry, buffers.vertices.byteLength);
    if (buffers.vertices.byteLength)
      this.#device.queue.writeBuffer(
        entry.vertexBuffer,
        0,
        buffers.vertices.buffer,
        buffers.vertices.byteOffset,
        buffers.vertices.byteLength,
      );
    this.#device.queue.writeBuffer(
      entry.lightingBuffer,
      0,
      buffers.lighting.buffer,
      buffers.lighting.byteOffset,
      buffers.lighting.byteLength,
    );
  }

  #prepareMedia(
    scene: FlattenedSceneLayer,
    playing: boolean,
    resolutionScale: number,
    textMotionBlur?: TextMotionBlurPlan,
  ): void {
    const mediaTextures = this.#mediaTextures;
    requirePlan(mediaTextures, "missing_resource", "Source media requires a media cache");
    if (scene.layer.kind === "text") {
      mediaTextures.prepareText(
        scene.layer,
        scene.resourceInstanceId,
        evaluateLayerSourceTime(scene.layer, scene.localTime),
        scene.sourceComposition.frameRate.numerator / scene.sourceComposition.frameRate.denominator,
        transformedTextRasterScale(resolutionScale, scene.transform.scale),
        textMotionBlur,
      );
      this.#mediaInstanceIds.add(scene.resourceInstanceId);
      return;
    }
    if (scene.layer.kind === "image" || scene.layer.kind === "video") {
      mediaTextures.prepareMedia(
        scene.layer,
        sourceForLayer(this.#project, scene.layer),
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
      this.#residentTextureCount() + textureCount > MAX_PRECOMPOSITION_SURFACE_TEXTURES ||
      this.#residentBytes() + estimatedBytes > this.#byteLimit
    )
      if (!this.#evictOldest()) throw new Error("Precomposition surface cache budget is exhausted");
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
    let reusable: SurfaceEntry | undefined;
    for (const entry of this.#entries.values()) {
      if (
        entry.lastUsedFrame === this.#frame ||
        entry.width !== width ||
        entry.height !== height ||
        Boolean(entry.effects) !== hasEffects
      )
        continue;
      if (!reusable || entry.lastUsedFrame < reusable.lastUsedFrame) reusable = entry;
    }
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

  #prepareEffects(
    entry: SurfaceEntry,
    composition: Composition,
    scene: readonly FlattenedSceneLayer[],
    time: number,
  ) {
    const header = buildFrameHeader({
      snapshot: { snapshotScope: "precomposition-effects", projectRevision: this.#revision },
      compositionId: composition.id,
      time,
      frameRate: composition.frameRate,
      target: { width: composition.width, height: composition.height },
      renderTarget: { width: entry.width, height: entry.height },
      antiAliasing: "off",
    });
    return (
      entry.effects?.prepareEffects(scene, composition, header, "precomposition") ??
      prepareLayerEffects({
        scene,
        composition,
        header,
        context: "precomposition",
        mipLevelCount: 1,
        planner: this.#directEffectPlanner,
      })
    );
  }

  #encodeJob(
    encoder: GPUCommandEncoder,
    plan: PrecompositionScenePlan,
    media: PrecompositionMediaBindings,
  ): void {
    executePrecompositionScene({
      plan,
      encoder,
      targets: this.#entries,
      generators: this.#generators,
      host: this.#sceneGenerators,
      media,
      surfacePipelines: this.#surfacePipelines,
      imagePipelines: this.#imagePipelines,
      shapePipelines: this.#shapePipelines,
    });
  }

  #sweep(activeKeys: ReadonlySet<string>): void {
    for (const [key, entry] of this.#entries) {
      if (activeKeys.has(key) || this.#frame - entry.lastUsedFrame <= CACHE_RETENTION_FRAMES)
        continue;
      destroyEntry(entry);
      this.#entries.delete(key);
    }
    while (
      this.#residentBytes() > this.#byteLimit ||
      this.#residentTextureCount() > MAX_PRECOMPOSITION_SURFACE_TEXTURES
    )
      if (!this.#evictOldest()) break;
  }

  #evictOldest(): boolean {
    let oldest: SurfaceEntry | undefined;
    for (const entry of this.#entries.values()) {
      if (entry.lastUsedFrame === this.#frame) continue;
      if (!oldest || entry.lastUsedFrame < oldest.lastUsedFrame) oldest = entry;
    }
    if (!oldest) return false;
    destroyEntry(oldest);
    this.#entries.delete(oldest.key);
    return true;
  }

  #residentBytes(): number {
    let total = 0;
    for (const entry of this.#entries.values()) total += entry.estimatedBytes;
    return total;
  }

  #residentTextureCount(): number {
    let total = 0;
    for (const entry of this.#entries.values()) total += entry.textureCount;
    return total;
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
  const pipelines = Object.fromEntries(
    FIXED_BLEND_MODES.map((blendMode) => [
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
  );
  return Object.fromEntries(
    BLEND_MODES.map((mode) => [mode, pipelines[mode] ?? pipelines.normal]),
  ) as Record<BlendMode, GPURenderPipeline>;
}

function destroyEntry(entry: SurfaceEntry): void {
  entry.effects?.destroy();
  entry.color.destroy();
  entry.depth.destroy();
  entry.vertexBuffer.destroy();
  entry.lightingBuffer.destroy();
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

export const precompositionSurfaceShader = sharedShaders.source("precomposition-surface");
