import {
  AUDIO_ANALYSIS_BYTES,
  buildAudioAnalysisFrame,
} from "../../core/audio/audio-analysis-frame";
import { logger } from "../../core/logger";
import type { FlattenedSceneLayer } from "../../core/scene/scene-evaluation";
import {
  findSceneGeneratorDefinition,
  getSceneGeneratorDefinitions,
  getSceneGeneratorRegistryRevision,
  type SceneGeneratorDefinition,
} from "../../core/scene/scene-generator-registry";
import type { BlendMode, Composition, SceneGeneratorInstance } from "../../core/types";
import { FIXED_BLEND_MODES, gpuBlendState } from "../compositing/blend-state";
import { buildGeneratorSlice, readGeneratorSlice } from "../frame-plan/generator-plan";
import type { FrameHeaderSlice } from "../frame-plan/types";
import type { SceneCamera } from "../geometry/geometry";
import {
  AUXILIARY_BUFFER_DESCRIPTORS,
  AUXILIARY_BUFFER_KINDS,
  supportsAuxiliaryMrt,
} from "../gpu/render-buffers";
import {
  SCENE_GENERATOR_CONTEXT_BYTES,
  SCENE_GENERATOR_PARAMETER_BYTES,
} from "./scene-generator-abi";

import {
  constrainGeneratorPlan,
  type SceneGeneratorAudioSource,
  type SceneGeneratorPlan,
  SceneGeneratorPlanner,
  validateGeneratorInvocation,
} from "./scene-generator-plan";
import {
  type GeneratorProgramPlan,
  generatorDefinitionKey,
  readGeneratorShaders,
} from "./scene-generator-program";

export { planGeneratorCapacity } from "./scene-generator-capacity";
export type { SceneGeneratorAudioSource } from "./scene-generator-plan";

const INITIAL_GENERATOR_CAPACITY = 1_024;

interface GeneratorResources {
  definitionKey: string;
  instanceStride: number;
  capacity: number;
  storage: GPUBuffer;
  indirect: GPUBuffer;
  context: GPUBuffer;
  parameters: GPUBuffer;
  computeBindGroup: GPUBindGroup;
  renderBindGroup: GPUBindGroup;
  resizeFailure?: number;
}

interface CompiledRenderVariant {
  definition: SceneGeneratorDefinition["graph"]["render_variants"][number];
  pipelines: ReadonlyMap<BlendMode, GPURenderPipeline>;
  auxiliaryPipeline?: GPURenderPipeline;
}

interface CompiledGenerator {
  key: string;
  sourceKey: string;
  instanceStride: number;
  computePipelines: readonly GPUComputePipeline[];
  variants: readonly CompiledRenderVariant[];
}

export interface PreparedSceneGenerator {
  instanceId: string;
  selectionId: string;
  blendMode: BlendMode;
  effectiveCount: number;
  requestedCount: number;
  lodApplied: boolean;
  resources: GeneratorResources;
  compiled: CompiledGenerator;
  variant: CompiledRenderVariant;
  dispatches: readonly [number, number, number][];
}

export interface SceneGeneratorAuxiliaryDraw {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  indirectBuffer: GPUBuffer;
}

/** Executes built-in and third-party scene generators through the same bounded ABI. */
export class SceneGeneratorHost {
  readonly #device: GPUDevice;
  readonly #format: GPUTextureFormat;
  readonly #computeBindGroupLayout: GPUBindGroupLayout;
  readonly #renderBindGroupLayout: GPUBindGroupLayout;
  readonly #computePipelineLayout: GPUPipelineLayout;
  readonly #renderPipelineLayout: GPUPipelineLayout;
  readonly #bundledDefinitions: readonly SceneGeneratorDefinition[];
  readonly #auxiliaryMrtSupported: boolean;
  readonly #audio: GPUBuffer;
  readonly #compiled = new Map<string, CompiledGenerator>();
  readonly #resources = new Map<string, GeneratorResources>();
  readonly #activeInstanceIds = new Set<string>();
  readonly #reportedFailures = new Set<string>();
  #registryRevision = -1;
  #diagnostics: string[] = [];
  readonly #planner = new SceneGeneratorPlanner();
  #frameAudio?: Uint8Array;

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    bundledDefinitions: readonly SceneGeneratorDefinition[] = [],
  ) {
    this.#device = device;
    this.#format = format;
    this.#bundledDefinitions = bundledDefinitions;
    this.#auxiliaryMrtSupported = supportsAuxiliaryMrt(device.limits);
    this.#computeBindGroupLayout = device.createBindGroupLayout({
      label: "Scene generator ABI v1 compute layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
      ],
    });
    this.#renderBindGroupLayout = device.createBindGroupLayout({
      label: "Scene generator ABI v1 render layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        {
          binding: 4,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
      ],
    });
    this.#computePipelineLayout = device.createPipelineLayout({
      label: "Scene generator ABI v1 compute pipeline layout",
      bindGroupLayouts: [this.#computeBindGroupLayout],
    });
    this.#renderPipelineLayout = device.createPipelineLayout({
      label: "Scene generator ABI v1 render pipeline layout",
      bindGroupLayouts: [this.#renderBindGroupLayout],
    });
    // One record serves every generator in a frame: all of them analyze the audio heard at the
    // root composition time, including generators nested in precompositions.
    this.#audio = device.createBuffer({
      label: "Scene generator audio analysis",
      size: AUDIO_ANALYSIS_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.#audio, 0, buildAudioAnalysisFrame(undefined, 0));
  }

  beginFrame(audioSource?: SceneGeneratorAudioSource): void {
    this.#activeInstanceIds.clear();
    this.#diagnostics = [];
    this.#planner.beginFrame(audioSource);
    this.#frameAudio = undefined;
    const revision = getSceneGeneratorRegistryRevision();
    if (revision !== this.#registryRevision) {
      this.#registryRevision = revision;
      const currentDefinitionKeys = new Set(
        [...this.#bundledDefinitions, ...getSceneGeneratorDefinitions()].map(
          generatorDefinitionKey,
        ),
      );
      for (const key of this.#compiled.keys()) {
        const compiled = this.#compiled.get(key);
        if (compiled && !currentDefinitionKeys.has(compiled.sourceKey)) this.#compiled.delete(key);
      }
      this.#reportedFailures.clear();
    }
  }

  supports(scene: FlattenedSceneLayer): boolean {
    return scene.layer.kind === "generator";
  }

  plan(
    scene: FlattenedSceneLayer,
    composition: Composition,
    width: number,
    height: number,
    memoryBudgetMb?: number,
    camera?: SceneCamera,
  ): SceneGeneratorPlan | undefined {
    const instance = scene.layer.generator;
    if (!instance) return this.#reportMissing(scene, "Generator layer has no plugin instance");
    const definition = this.#resolveDefinition(instance);
    if (!definition)
      return this.#reportMissing(
        scene,
        `Missing or disabled scene generator ${instance.pluginId}:${instance.nodeType}`,
      );
    if (instance.apiVersion !== definition.apiVersion)
      return this.#reportMissing(
        scene,
        `Scene generator ${instance.pluginId}:${instance.nodeType} requires API ${instance.apiVersion}; installed definition provides ${definition.apiVersion}`,
      );
    try {
      return this.#planner.prepare({
        scene,
        composition,
        definition,
        width,
        height,
        memoryBudgetMb,
        camera,
        storageByteLimit: Math.min(
          Number(this.#device.limits.maxStorageBufferBindingSize),
          Number(this.#device.limits.maxBufferSize),
        ),
        dispatchWorkgroupLimit: Number(this.#device.limits.maxComputeWorkgroupsPerDimension),
      });
    } catch (error) {
      return this.#reportMissing(
        scene,
        `Scene generator ${instance.pluginId} failed to prepare: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  prepare(
    scene: FlattenedSceneLayer,
    composition: Composition,
    width: number,
    height: number,
    memoryBudgetMb?: number,
    camera?: SceneCamera,
    header?: FrameHeaderSlice,
  ): PreparedSceneGenerator | undefined {
    const plan = this.plan(scene, composition, width, height, memoryBudgetMb, camera);
    if (!plan) return undefined;
    return this.preparePlanned(
      plan,
      { layerName: scene.layer.name, pluginId: scene.layer.generator?.pluginId ?? "" },
      header,
    );
  }

  preparePlanned(
    plan: SceneGeneratorPlan,
    source: { layerName: string; pluginId: string },
    header?: FrameHeaderSlice,
  ): PreparedSceneGenerator | undefined {
    try {
      const supplied = header
        ? readGeneratorSlice(
            buildGeneratorSlice(header, plan),
            new Map(plan.program.shaders.map((r) => [r.message.hash, r])),
          )
        : plan;
      return this.preparePlan(supplied);
    } catch (error) {
      return this.#reportMissing(
        { instanceId: plan.instanceId, layer: { name: source.layerName } },
        `Scene generator ${source.pluginId} failed to prepare: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** GPU realization consumes only supplied executable descriptors and owned ABI payloads. */
  preparePlan(input: SceneGeneratorPlan): PreparedSceneGenerator {
    validateGeneratorInvocation(input);
    if (
      input.audio &&
      this.#frameAudio &&
      input.audio.some((value, index) => value !== this.#frameAudio?.[index])
    )
      throw Error("Generator audio differs within the root frame");
    const compiled = this.#compile(input.program);
    const resources = this.#resource(input.instanceId, compiled, input.capacity);
    const plan = constrainGeneratorPlan(input, resources.capacity);
    this.#activeInstanceIds.add(plan.instanceId);
    this.#device.queue.writeBuffer(resources.context, 0, plan.context as Uint8Array<ArrayBuffer>);
    this.#device.queue.writeBuffer(
      resources.parameters,
      0,
      plan.parameters as Uint8Array<ArrayBuffer>,
    );
    this.#device.queue.writeBuffer(resources.indirect, 0, plan.indirect as Uint8Array<ArrayBuffer>);
    if (plan.audio && !this.#frameAudio) {
      this.#device.queue.writeBuffer(this.#audio, 0, plan.audio as Uint8Array<ArrayBuffer>);
      this.#frameAudio = plan.audio.slice();
    }
    return {
      instanceId: plan.instanceId,
      selectionId: plan.selectionId,
      blendMode: plan.blendMode,
      effectiveCount: plan.effectiveCount,
      requestedCount: plan.requestedCount,
      lodApplied: plan.effectiveCount < plan.requestedCount,
      resources,
      compiled,
      variant: compiled.variants[plan.variantIndex],
      dispatches: plan.dispatches.map((d) => [...d]),
    };
  }

  encodeCompute(pass: GPUComputePassEncoder, generator: PreparedSceneGenerator): void {
    for (let index = 0; index < generator.compiled.computePipelines.length; index += 1) {
      const dispatch = generator.dispatches[index];
      pass.setPipeline(generator.compiled.computePipelines[index]);
      pass.setBindGroup(0, generator.resources.computeBindGroup);
      pass.dispatchWorkgroups(...dispatch);
    }
  }

  draw(
    pass: GPURenderPassEncoder,
    generator: PreparedSceneGenerator,
    blendMode = generator.blendMode,
  ): void {
    const pipeline =
      generator.variant.pipelines.get(blendMode) ??
      generator.variant.pipelines.values().next().value;
    if (!pipeline) return;
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, generator.resources.renderBindGroup);
    pass.drawIndirect(generator.resources.indirect, 0);
  }

  auxiliaryDraw(generator: PreparedSceneGenerator): SceneGeneratorAuxiliaryDraw | undefined {
    return generator.variant.auxiliaryPipeline
      ? {
          pipeline: generator.variant.auxiliaryPipeline,
          bindGroup: generator.resources.renderBindGroup,
          indirectBuffer: generator.resources.indirect,
        }
      : undefined;
  }

  sweep(): void {
    for (const [instanceId, resources] of this.#resources) {
      if (this.#activeInstanceIds.has(instanceId)) continue;
      destroyResources(resources);
      this.#resources.delete(instanceId);
    }
  }

  get diagnostics(): readonly string[] {
    return this.#diagnostics;
  }

  get estimatedBytes(): number {
    let total = 0;
    for (const resources of this.#resources.values()) {
      total +=
        resources.capacity * resources.instanceStride +
        SCENE_GENERATOR_CONTEXT_BYTES +
        SCENE_GENERATOR_PARAMETER_BYTES +
        16;
    }
    return total + AUDIO_ANALYSIS_BYTES;
  }

  destroy(): void {
    for (const resources of this.#resources.values()) destroyResources(resources);
    this.#resources.clear();
    this.#compiled.clear();
    this.#audio.destroy();
  }

  #reportMissing(
    scene: { instanceId: string; layer: { name: string } },
    message: string,
  ): undefined {
    this.#diagnostics.push(`${scene.layer.name}: ${message}`);
    const key = `${scene.instanceId}:${message}`;
    if (!this.#reportedFailures.has(key)) {
      this.#reportedFailures.add(key);
      logger.warn("webgpu", "scene_generator_unavailable", {
        instanceId: scene.instanceId,
        message,
      });
    }
    return undefined;
  }

  #resolveDefinition(instance: SceneGeneratorInstance): SceneGeneratorDefinition | undefined {
    return (
      this.#bundledDefinitions.find(
        (definition) =>
          definition.pluginId === instance.pluginId && definition.nodeType === instance.nodeType,
      ) ?? findSceneGeneratorDefinition(instance.pluginId, instance.nodeType)
    );
  }

  #compile(program: GeneratorProgramPlan): CompiledGenerator {
    const key = program.key;
    const existing = this.#compiled.get(key);
    if (existing) return existing;
    const sources = readGeneratorShaders(program);
    const modules = new Map<string, GPUShaderModule>();
    const module = (path: string) => {
      const cached = modules.get(path);
      if (cached) return cached;
      const code = sources.get(path);
      if (!code) throw new Error(`Runtime shader ${path} is unavailable`);
      const created = this.#device.createShaderModule({
        label: `${program.label} · ${path}`,
        code,
      });
      modules.set(path, created);
      return created;
    };
    const computePipelines = program.graph.compute_passes.map((pass) =>
      this.#device.createComputePipeline({
        label: `${program.label} · ${pass.id}`,
        layout: this.#computePipelineLayout,
        compute: { module: module(pass.shader), entryPoint: pass.entry_point },
      }),
    );
    const variants = program.graph.render_variants.map((variant) => {
      const blendModes: readonly BlendMode[] =
        variant.blend === "layer" ? FIXED_BLEND_MODES : [variant.blend];
      const pipelines = new Map<BlendMode, GPURenderPipeline>();
      for (const blendMode of blendModes) {
        pipelines.set(
          blendMode,
          this.#device.createRenderPipeline({
            label: `${program.label} · ${variant.id} · ${blendMode}`,
            layout: this.#renderPipelineLayout,
            vertex: { module: module(variant.shader), entryPoint: variant.vertex_entry },
            fragment: {
              module: module(variant.shader),
              entryPoint: variant.fragment_entry,
              targets: [{ format: this.#format, blend: gpuBlendState(blendMode) }],
            },
            primitive: { topology: "triangle-list", cullMode: variant.cull },
            depthStencil: depthState(variant.depth),
          }),
        );
      }
      const auxiliaryPipeline =
        variant.auxiliary && this.#auxiliaryMrtSupported
          ? this.#device.createRenderPipeline({
              label: `${program.label} · ${variant.id} · auxiliary MRT`,
              layout: this.#renderPipelineLayout,
              vertex: {
                module: module(variant.auxiliary.shader),
                entryPoint: variant.auxiliary.vertex_entry,
              },
              fragment: {
                module: module(variant.auxiliary.shader),
                entryPoint: variant.auxiliary.fragment_entry,
                targets: AUXILIARY_BUFFER_KINDS.map((kind) => ({
                  format: AUXILIARY_BUFFER_DESCRIPTORS[kind].format,
                })),
              },
              primitive: { topology: "triangle-list", cullMode: variant.cull },
              depthStencil: depthState(variant.depth),
            })
          : undefined;
      return { definition: structuredClone(variant), pipelines, auxiliaryPipeline };
    });
    const compiled = {
      key,
      sourceKey: program.sourceKey,
      instanceStride: program.graph.instance_stride,
      computePipelines,
      variants,
    };
    this.#compiled.set(key, compiled);
    return compiled;
  }

  #resource(
    instanceId: string,
    compiled: CompiledGenerator,
    requiredCapacity: number,
  ): GeneratorResources {
    const existing = this.#resources.get(instanceId);
    if (
      existing &&
      existing.definitionKey === compiled.key &&
      requiredCapacity <= existing.capacity
    )
      return existing;
    const capacity = existing
      ? requiredCapacity
      : Math.max(INITIAL_GENERATOR_CAPACITY, requiredCapacity);
    try {
      const next = this.#createResources(instanceId, compiled, capacity);
      if (existing) destroyResources(existing);
      this.#resources.set(instanceId, next);
      return next;
    } catch (error) {
      if (existing && existing.definitionKey === compiled.key) {
        if (existing.resizeFailure !== requiredCapacity) {
          existing.resizeFailure = requiredCapacity;
          logger.warn(
            "webgpu",
            "scene_generator_storage_resize_failed",
            { instanceId, retainedCapacity: existing.capacity, requiredCapacity },
            error,
          );
        }
        return existing;
      }
      throw error;
    }
  }

  #createResources(
    instanceId: string,
    compiled: CompiledGenerator,
    capacity: number,
  ): GeneratorResources {
    const storage = this.#device.createBuffer({
      label: `Scene generator storage · ${instanceId} · ${capacity.toLocaleString()}`,
      size: capacity * compiled.instanceStride,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const indirect = this.#device.createBuffer({
      label: `Scene generator indirect draw · ${instanceId}`,
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE,
    });
    const context = this.#device.createBuffer({
      label: `Scene generator context · ${instanceId}`,
      size: SCENE_GENERATOR_CONTEXT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const parameters = this.#device.createBuffer({
      label: `Scene generator parameters · ${instanceId}`,
      size: SCENE_GENERATOR_PARAMETER_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    try {
      return {
        definitionKey: compiled.key,
        instanceStride: compiled.instanceStride,
        capacity,
        storage,
        indirect,
        context,
        parameters,
        computeBindGroup: this.#device.createBindGroup({
          label: `Scene generator compute resources · ${instanceId}`,
          layout: this.#computeBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: context } },
            { binding: 1, resource: { buffer: parameters } },
            { binding: 2, resource: { buffer: storage } },
            { binding: 3, resource: { buffer: indirect } },
            { binding: 4, resource: { buffer: this.#audio } },
          ],
        }),
        renderBindGroup: this.#device.createBindGroup({
          label: `Scene generator render resources · ${instanceId}`,
          layout: this.#renderBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: context } },
            { binding: 1, resource: { buffer: parameters } },
            { binding: 2, resource: { buffer: storage } },
            { binding: 4, resource: { buffer: this.#audio } },
          ],
        }),
      };
    } catch (error) {
      storage.destroy();
      indirect.destroy();
      context.destroy();
      parameters.destroy();
      throw error;
    }
  }
}

function depthState(mode: "none" | "read" | "read_write"): GPUDepthStencilState {
  return {
    format: "depth24plus",
    depthWriteEnabled: mode === "read_write",
    depthCompare: mode === "none" ? "always" : "less-equal",
  };
}

function destroyResources(resources: GeneratorResources): void {
  resources.storage.destroy();
  resources.indirect.destroy();
  resources.context.destroy();
  resources.parameters.destroy();
}
