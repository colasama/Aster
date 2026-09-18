import { createSurfacePipelines } from "./precomposition-surface-pipeline";
import { SurfacePostProcessing } from "./surface-post-processing";

export { precompositionSurfaceShader } from "./precomposition-surface-pipeline";

import { evaluateLayerSourceTime } from "../../core/animation/layer-time";
import { sourceForLayer, sourceLocator } from "../../core/media/footage-source";
import { type FlattenedSceneLayer, flattenSceneLayers } from "../../core/scene/scene-evaluation";
import type { BlendMode, Composition, Layer, Project } from "../../core/types";
import { LayerEffectRenderer } from "../effects/layer-effects";
import { buildSceneGeometry, FLOATS_PER_VERTEX, type GeometryBatch } from "../geometry/geometry";
import type { MediaTextureCache } from "../media/media-texture-cache";
import { evaluateSceneCamera } from "../scene/scene-camera";
import type { PreparedSceneGenerator, SceneGeneratorHost } from "../scene/scene-generator-host";
import { buildSceneLighting, SCENE_LIGHTING_BYTES } from "../scene/scene-lighting";
import { planTextMotionBlurFrame, type TextMotionBlurPlan } from "../text/text-motion-blur-plan";
import { transformedTextRasterScale } from "../text/text-rasterizer";
import type { ExactTransparencyRenderer } from "./exact-transparency";
import { needsLayerIsolation } from "./layer-composite";
import {
  createPrecompositionSurfaceBudget,
  MAX_PRECOMPOSITION_SURFACE_BYTES,
  planPrecompositionSurface,
  precompositionSurfaceCacheKey,
} from "./precomposition-surface-plan";
import { planSceneRenderStack } from "./render-stack";
import { SurfaceLighting } from "./surface-lighting";
import { transparencyGroups } from "./transparency-groups";

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
  lighting?: SurfaceLighting;
  post?: SurfacePostProcessing;
  estimatedBytes: number;
  textureCount: number;
  lastUsedFrame: number;
}

interface SurfaceJob {
  entry: SurfaceEntry;
  composition: Composition;
  time: number;
  wrapper: Layer;
  wrapperTime: number;
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
  transparency?: ExactTransparencyRenderer;
  invalidate?: () => void;
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
  readonly #transparency?: ExactTransparencyRenderer;
  readonly #invalidate: () => void;
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
    this.#transparency = options.transparency;
    this.#invalidate = options.invalidate ?? (() => {});
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
    const residentLimit = Math.min(
      MAX_PRECOMPOSITION_SURFACE_BYTES,
      (memoryBudgetMb === undefined ? 256 : Math.max(1, memoryBudgetMb * 0.35)) * 1024 * 1024,
    );
    while (this.#residentBytes() > residentLimit) {
      if (!this.#evictOldest())
        throw new Error(
          "Nested composition materials and camera buffers exceed the surface VRAM budget",
        );
    }
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

  get hasPendingResources(): boolean {
    return this.#jobs.some((job) => job.entry.lighting?.material.hasPendingResources);
  }

  async waitForResources(): Promise<void> {
    await Promise.all(this.#jobs.map((job) => job.entry.lighting?.material.waitForResources()));
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
    const renderComposition = surface.renderComposition ?? surface.composition;
    const effectKey =
      surface.sceneLayers || scene.layer.effects.some((effect) => effect.enabled)
        ? `:${scene.instanceId}:${scene.localTime}`
        : "";
    const logicalKey = `${this.#revision}:${surface.composition.id}:${surface.time.toFixed(9)}${effectKey}`;
    const shared = preparedSources.get(logicalKey);
    if (shared) {
      shared.lastUsedFrame = this.#frame;
      this.#bindings.set(scene.instanceId, shared.bindGroup);
      return;
    }
    let childLayers: FlattenedSceneLayer[];
    try {
      childLayers = namespaceSurfaceLayers(
        surface.sceneLayers ?? flattenSceneLayers(surface.composition, project, surface.time),
        scene.resourceInstanceId,
        surface.compositionPath,
      );
    } catch (error) {
      throw new Error(`Could not evaluate ${surface.composition.name}: ${String(error)}`);
    }
    const hasEffects =
      scene.layer.effects.some((effect) => effect.enabled) ||
      childLayers.some(
        (child) => child.layer.kind === "adjustment" || needsLayerIsolation(child.layer),
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
    if (plan.status === "skipped")
      throw new Error(`${surface.composition.name}: ${plan.diagnostic}`);
    const key =
      precompositionSurfaceCacheKey(scene, this.#revision, plan.width, plan.height) + effectKey;
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
    const camera = evaluateSceneCamera(renderComposition, surface.cameraTime ?? surface.time);
    const geometry = buildSceneGeometry(renderComposition, childLayers, camera);
    this.#ensureVertexBuffer(entry, geometry.data.byteLength);
    if (geometry.data.byteLength > 0)
      this.#device.queue.writeBuffer(entry.vertexBuffer, 0, geometry.data);
    const cameraPosition = camera?.pose.position;
    const advanced =
      renderComposition.environment?.enabled ||
      geometry.batches.some((batch) => batch.layer.mesh?.materialTextures?.normal) ||
      childLayers.some((child) => child.layer.kind === "light");
    if (advanced && !entry.lighting)
      entry.lighting = new SurfaceLighting(
        this.#device,
        this.#lightingLayout,
        entry.lightingBuffer,
        this.#invalidate,
        (message) => {
          if (message) diagnostics.push(message);
        },
      );
    if (entry.lighting) {
      entry.lighting.prepare(renderComposition, childLayers, geometry.batches, cameraPosition);
      if (entry.lighting.binding) entry.lightingBindGroup = entry.lighting.binding;
    } else
      this.#device.queue.writeBuffer(
        entry.lightingBuffer,
        0,
        buildSceneLighting(childLayers, renderComposition, false, cameraPosition),
      );
    if (!surface.sceneLayers && SurfacePostProcessing.needed(renderComposition, camera, geometry)) {
      entry.post ??= new SurfacePostProcessing(this.#device, this.#mediaLayout);
      entry.post.prepare(
        renderComposition,
        surface.time,
        camera,
        geometry,
        (sampleTime) =>
          buildSceneGeometry(
            renderComposition,
            namespaceSurfaceLayers(
              flattenSceneLayers(surface.composition, project, sampleTime),
              scene.resourceInstanceId,
              surface.compositionPath,
            ),
            evaluateSceneCamera(renderComposition, sampleTime),
          ),
        entry.color,
        entry.width,
        entry.height,
        memoryBudgetMb,
      );
    } else if (entry.post) {
      entry.post.destroy();
      entry.post = undefined;
    }
    this.#jobs.push({
      entry,
      composition: renderComposition,
      time: surface.cameraTime ?? surface.time,
      wrapper: scene.layer,
      wrapperTime: scene.localTime,
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
        transformedTextRasterScale(resolutionScale, scene.transform.scale),
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
    while (this.#residentBytes() + estimatedBytes > MAX_PRECOMPOSITION_SURFACE_BYTES) {
      if (!this.#evictOldest()) throw new Error("Precomposition resident VRAM budget exhausted");
    }
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

  #encodeJob(encoder: GPUCommandEncoder, job: SurfaceJob): void {
    const { entry, composition, geometry, sceneLayers, time, generators } = job;
    entry.lighting?.encode(encoder, entry.vertexBuffer, geometry.batches);
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
    let clearDepth = false;
    const transparentGroups = this.#transparency
      ? transparencyGroups(stack)
      : new Map<string, GeometryBatch[]>();
    const captured = new Set<string>();
    for (const item of stack) {
      if (item.kind === "geometry" && captured.has(item.batch.instanceId)) continue;
      if (item.clearDepth) {
        pass?.end();
        pass = undefined;
        clearDepth = true;
      }
      if (item.kind === "generator") {
        const generator = generatorByInstance.get(item.scene.instanceId);
        if (!generator) continue;
        if (needsLayerIsolation(item.scene.layer)) {
          pass?.end();
          pass = undefined;
          activeEffects.add(item.scene.instanceId);
          entry.effects?.encode(
            encoder,
            entry.color,
            composition,
            item.scene.layer,
            item.scene.instanceId,
            item.scene.localTime,
            (layerPass) => this.#sceneGenerators?.draw(layerPass, generator, "normal"),
          );
          continue;
        }
        pass ??= this.#resumePass(encoder, entry, clearDepth);
        clearDepth = false;
        this.#sceneGenerators?.draw(pass, generator);
        continue;
      }
      if (item.kind === "adjustment") {
        if (!needsLayerIsolation(item.scene.layer)) continue;
        pass?.end();
        pass = undefined;
        const count = entry.effects?.encodeAdjustment(
          encoder,
          entry.color,
          composition,
          item.scene.layer,
          item.scene.instanceId,
          item.scene.localTime,
        );
        if (count) activeEffects.add(item.scene.instanceId);
        continue;
      }
      const { batch } = item;
      const transparentGroup = transparentGroups.get(batch.instanceId);
      if (transparentGroup && this.#transparency) {
        pass?.end();
        pass = undefined;
        this.#transparency.encode(
          encoder,
          entry.color,
          entry.depth.createView(),
          entry.width,
          entry.height,
          transparentGroup.map((batch) => ({
            blendMode: batch.layer.blendMode,
            triangleCount: batch.vertexCount / 3,
            draw: (pass) => this.#drawBatch(pass, entry, batch, "normal"),
          })),
        );
        for (const batch of transparentGroup) captured.add(batch.instanceId);
        clearDepth = true;
        continue;
      }
      if (needsLayerIsolation(batch.layer)) {
        pass?.end();
        pass = undefined;
        activeEffects.add(batch.instanceId);
        entry.effects?.encode(
          encoder,
          entry.color,
          composition,
          batch.layer,
          batch.instanceId,
          batch.localTime ?? time,
          (layerPass) => this.#drawBatch(layerPass, entry, batch, "normal"),
        );
        continue;
      }
      pass ??= this.#resumePass(encoder, entry, clearDepth);
      clearDepth = false;
      this.#drawBatch(pass, entry, batch);
    }
    pass?.end();
    entry.post?.encode(
      encoder,
      entry.vertexBuffer,
      geometry,
      (batch) =>
        this.#bindings.get(batch.instanceId) ??
        this.#mediaTextures.bindGroup(batch.resourceInstanceId),
      generators
        .map((generator) => this.#sceneGenerators?.auxiliaryDraw(generator))
        .filter((draw) => draw !== undefined),
    );
    if (job.wrapper.effects.some((effect) => effect.enabled)) {
      const instanceId = `wrapper:${job.wrapper.id}`;
      entry.effects?.encodeAdjustment(
        encoder,
        entry.color,
        composition,
        job.wrapper,
        instanceId,
        job.wrapperTime,
      );
      activeEffects.add(instanceId);
    }
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
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
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

  #resumePass(
    encoder: GPUCommandEncoder,
    entry: SurfaceEntry,
    clearDepth: boolean,
  ): GPURenderPassEncoder {
    return encoder.beginRenderPass({
      label: "Resume isolated precomposition stack",
      colorAttachments: [{ view: entry.color.createView(), loadOp: "load", storeOp: "store" }],
      depthStencilAttachment: {
        view: entry.depth.createView(),
        depthClearValue: 1,
        depthLoadOp: clearDepth ? "clear" : "load",
        depthStoreOp: "store",
      },
    });
  }

  #drawBatch(
    pass: GPURenderPassEncoder,
    entry: SurfaceEntry,
    batch: GeometryBatch,
    blendMode = batch.layer.blendMode,
  ): void {
    pass.setVertexBuffer(0, entry.vertexBuffer);
    const surface =
      batch.layer.kind === "precomposition" ? this.#bindings.get(batch.instanceId) : undefined;
    if (surface) {
      pass.setPipeline(this.#surfacePipelines[blendMode]);
      pass.setBindGroup(0, surface);
    } else {
      const media =
        batch.layer.kind === "image" || batch.layer.kind === "video" || batch.layer.kind === "text"
          ? this.#mediaTextures.bindGroup(batch.resourceInstanceId)
          : undefined;
      if (batch.layer.kind === "precomposition" && !media) return;
      const material = entry.lighting?.material.bindingFor(
        batch.layer,
        batch.resourceInstanceId,
        blendMode,
        entry.lighting.environment,
      );
      if (material) {
        pass.setPipeline(material.pipeline);
        pass.setBindGroup(0, entry.lightingBindGroup);
        pass.setBindGroup(1, material.bindGroup);
      } else if (media) {
        pass.setPipeline(this.#imagePipelines[blendMode]);
        pass.setBindGroup(0, media);
      } else {
        pass.setPipeline(this.#shapePipelines[blendMode]);
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

  #evictOldest(): boolean {
    let oldest: SurfaceEntry | undefined;
    for (const entry of this.#entries.values())
      if (
        entry.lastUsedFrame !== this.#frame &&
        (!oldest || entry.lastUsedFrame < oldest.lastUsedFrame)
      )
        oldest = entry;
    if (!oldest) return false;
    destroyEntry(oldest);
    this.#entries.delete(oldest.key);
    return true;
  }

  #residentBytes(): number {
    let total = 0;
    for (const entry of this.#entries.values())
      total +=
        entry.estimatedBytes +
        (entry.lighting?.estimatedBytes ?? 0) +
        (entry.post?.estimatedBytes ?? 0);
    return total;
  }

  #residentTextureCount(): number {
    let total = 0;
    for (const entry of this.#entries.values()) total += entry.textureCount;
    return total;
  }
}

function destroyEntry(entry: SurfaceEntry): void {
  entry.effects?.destroy();
  entry.lighting?.destroy();
  entry.post?.destroy();
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
