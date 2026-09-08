import { evaluateLayerSourceTime } from "../core/layer-time";
import { logger } from "../core/logger";
import type { FlattenedSceneLayer } from "../core/scene-evaluation";
import {
  findSceneGeneratorDefinition,
  getSceneGeneratorDefinitions,
  getSceneGeneratorRegistryRevision,
  type SceneGeneratorDefinition,
} from "../core/scene-generator-registry";
import type { BlendMode, Composition, SceneGeneratorInstance } from "../core/types";
import { FIXED_BLEND_MODES, gpuBlendState } from "./blend-state";
import type { SceneCamera } from "./geometry";
import {
  AUXILIARY_BUFFER_DESCRIPTORS,
  AUXILIARY_BUFFER_KINDS,
  supportsAuxiliaryMrt,
} from "./render-buffers";
import {
  buildSceneGeneratorContext,
  buildSceneGeneratorParameters,
  SCENE_GENERATOR_CONTEXT_BYTES,
  SCENE_GENERATOR_PARAMETER_BYTES,
} from "./scene-generator-abi";

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
  definition: SceneGeneratorDefinition;
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
  readonly #compiled = new Map<string, CompiledGenerator>();
  readonly #resources = new Map<string, GeneratorResources>();
  readonly #activeInstanceIds = new Set<string>();
  readonly #reportedFailures = new Set<string>();
  #registryRevision = -1;
  #diagnostics: string[] = [];

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
  }

  beginFrame(): void {
    this.#activeInstanceIds.clear();
    this.#diagnostics = [];
    const revision = getSceneGeneratorRegistryRevision();
    if (revision !== this.#registryRevision) {
      this.#registryRevision = revision;
      const currentDefinitionKeys = new Set(
        [...this.#bundledDefinitions, ...getSceneGeneratorDefinitions()].map(definitionKey),
      );
      for (const key of this.#compiled.keys()) {
        if (!currentDefinitionKeys.has(key)) this.#compiled.delete(key);
      }
      this.#reportedFailures.clear();
    }
  }

  supports(scene: FlattenedSceneLayer): boolean {
    return scene.layer.kind === "generator";
  }

  prepare(
    scene: FlattenedSceneLayer,
    composition: Composition,
    width: number,
    height: number,
    memoryBudgetMb?: number,
    camera?: SceneCamera,
  ): PreparedSceneGenerator | undefined {
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
    let compiled: CompiledGenerator;
    try {
      compiled = this.#compile(definition);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.#reportMissing(
        scene,
        `Scene generator ${instance.pluginId} failed to compile: ${message}`,
      );
    }
    try {
      const variant = selectVariant(compiled, instance);
      const requestedCount = boundedCount(instance, definition);
      const capacityPlan = planGeneratorCapacity(
        requestedCount,
        definition.graph.max_instances,
        definition.graph.instance_stride,
        variant.definition.vertex_count,
        memoryBudgetMb,
        Math.min(
          Number(this.#device.limits.maxStorageBufferBindingSize),
          Number(this.#device.limits.maxBufferSize),
        ),
        Number(this.#device.limits.maxComputeWorkgroupsPerDimension) *
          Math.min(...definition.graph.compute_passes.map((pass) => pass.workgroup_size[0])),
      );
      const resources = this.#resource(scene.instanceId, compiled, capacityPlan.capacity);
      this.#activeInstanceIds.add(scene.instanceId);
      const effectiveCount = Math.min(capacityPlan.effectiveCount, resources.capacity);
      const frameDuration =
        composition.frameRate.denominator / Math.max(composition.frameRate.numerator, 1);
      const localTime = evaluateLayerSourceTime(scene.layer, scene.localTime);
      const contextScene = localTime === scene.localTime ? scene : { ...scene, localTime };
      this.#device.queue.writeBuffer(
        resources.context,
        0,
        buildSceneGeneratorContext(
          contextScene,
          composition,
          camera,
          width,
          height,
          scene.localTime,
          frameDuration,
          effectiveCount,
        ),
      );
      this.#device.queue.writeBuffer(
        resources.parameters,
        0,
        buildSceneGeneratorParameters(definition, instance),
      );
      this.#device.queue.writeBuffer(
        resources.indirect,
        0,
        new Uint32Array([variant.definition.vertex_count, 0, 0, 0]),
      );
      return {
        instanceId: scene.instanceId,
        selectionId: scene.selectionId,
        blendMode: scene.layer.blendMode,
        effectiveCount,
        requestedCount,
        lodApplied: effectiveCount < requestedCount,
        resources,
        compiled,
        variant,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.#reportMissing(
        scene,
        `Scene generator ${instance.pluginId} failed to prepare: ${message}`,
      );
    }
  }

  encodeCompute(pass: GPUComputePassEncoder, generator: PreparedSceneGenerator): void {
    const passes = generator.compiled.definition.graph.compute_passes;
    for (let index = 0; index < generator.compiled.computePipelines.length; index += 1) {
      const workgroup = passes[index].workgroup_size;
      pass.setPipeline(generator.compiled.computePipelines[index]);
      pass.setBindGroup(0, generator.resources.computeBindGroup);
      pass.dispatchWorkgroups(Math.ceil(generator.effectiveCount / workgroup[0]), 1, 1);
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
    return total;
  }

  destroy(): void {
    for (const resources of this.#resources.values()) destroyResources(resources);
    this.#resources.clear();
    this.#compiled.clear();
  }

  #reportMissing(scene: FlattenedSceneLayer, message: string): undefined {
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

  #compile(definition: SceneGeneratorDefinition): CompiledGenerator {
    const key = definitionKey(definition);
    const existing = this.#compiled.get(key);
    if (existing) return existing;
    const modules = new Map<string, GPUShaderModule>();
    const module = (path: string) => {
      const cached = modules.get(path);
      if (cached) return cached;
      const code = definition.shaderSources[path];
      if (!code) throw new Error(`Runtime shader ${path} is unavailable`);
      const created = this.#device.createShaderModule({
        label: `${definition.pluginName} · ${path}`,
        code,
      });
      modules.set(path, created);
      return created;
    };
    const computePipelines = definition.graph.compute_passes.map((pass) =>
      this.#device.createComputePipeline({
        label: `${definition.pluginName} · ${pass.id}`,
        layout: this.#computePipelineLayout,
        compute: { module: module(pass.shader), entryPoint: pass.entry_point },
      }),
    );
    const variants = definition.graph.render_variants.map((variant) => {
      const blendModes: readonly BlendMode[] =
        variant.blend === "layer" ? FIXED_BLEND_MODES : [variant.blend];
      const pipelines = new Map<BlendMode, GPURenderPipeline>();
      for (const blendMode of blendModes) {
        pipelines.set(
          blendMode,
          this.#device.createRenderPipeline({
            label: `${definition.pluginName} · ${variant.id} · ${blendMode}`,
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
              label: `${definition.pluginName} · ${variant.id} · auxiliary MRT`,
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
      return { definition: variant, pipelines, auxiliaryPipeline };
    });
    const compiled = { key, definition, computePipelines, variants };
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
      size: capacity * compiled.definition.graph.instance_stride,
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
        instanceStride: compiled.definition.graph.instance_stride,
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
          ],
        }),
        renderBindGroup: this.#device.createBindGroup({
          label: `Scene generator render resources · ${instanceId}`,
          layout: this.#renderBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: context } },
            { binding: 1, resource: { buffer: parameters } },
            { binding: 2, resource: { buffer: storage } },
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

function definitionKey(definition: SceneGeneratorDefinition): string {
  return `${definition.pluginId}:${definition.nodeType}:${definition.runtimeKey}`;
}

function selectVariant(
  compiled: CompiledGenerator,
  instance: SceneGeneratorInstance,
): CompiledRenderVariant {
  const selector = compiled.definition.graph.render_parameter
    ? String(instance.parameters[compiled.definition.graph.render_parameter] ?? "")
    : undefined;
  return (
    compiled.variants.find((variant) => variant.definition.selector_value === selector) ??
    compiled.variants[0]
  );
}

function boundedCount(
  instance: SceneGeneratorInstance,
  definition: SceneGeneratorDefinition,
): number {
  return Math.max(
    1,
    Math.min(
      definition.graph.max_instances,
      Math.round(numericParameter(instance, definition.graph.capacity_parameter, 1)),
    ),
  );
}

function numericParameter(
  instance: SceneGeneratorInstance,
  name: string,
  fallback: number,
): number {
  const value = instance.parameters[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function planGeneratorCapacity(
  requestedCount: number,
  maximumCount: number,
  stride: number,
  verticesPerInstance: number,
  budgetMb = 512,
  storageByteLimit = Number.POSITIVE_INFINITY,
  dispatchInstanceLimit = Number.POSITIVE_INFINITY,
): { effectiveCount: number; capacity: number } {
  const boundedBudgetMb = Number.isFinite(budgetMb) ? Math.max(16, budgetMb) : 512;
  const memoryLimit = Math.max(1_024, Math.floor((boundedBudgetMb * 1024 * 1024 * 0.125) / stride));
  const deviceStorageLimit = Math.max(1, Math.floor(storageByteLimit / stride));
  const boundedDispatchLimit = Math.max(1, Math.floor(dispatchInstanceLimit));
  const vertexLimit = Math.max(
    16_384,
    Math.floor((boundedBudgetMb * 12_288) / Math.max(verticesPerInstance, 1)),
  );
  const effectiveCount = Math.min(
    requestedCount,
    maximumCount,
    memoryLimit,
    deviceStorageLimit,
    boundedDispatchLimit,
    vertexLimit,
  );
  const capacityCeiling = Math.min(maximumCount, deviceStorageLimit);
  return {
    effectiveCount,
    capacity: Math.min(
      capacityCeiling,
      2 **
        Math.ceil(
          Math.log2(
            Math.min(capacityCeiling, Math.max(INITIAL_GENERATOR_CAPACITY, effectiveCount)),
          ),
        ),
    ),
  };
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
