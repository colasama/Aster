import {
  HOST_PLUGIN_API_VERSION,
  type PluginManifest,
  type PluginParameter,
  type PluginStatus,
  type SceneGeneratorGraph,
} from "./plugins";
import { assertSceneGeneratorInstance } from "./scene-generator";
import type { SceneGeneratorInstance, SceneGeneratorParameterValue } from "./types";

export interface SceneGeneratorDefinition {
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  nodeType: string;
  apiVersion: number;
  parameters: readonly PluginParameter[];
  graph: SceneGeneratorGraph;
  shaderSources: Readonly<Record<string, string>>;
  /** Stable content identity used to invalidate only generators whose executable contract changed. */
  runtimeKey: string;
}

type Listener = () => void;

const listeners = new Set<Listener>();
const MAX_SHADER_BYTES = 4 * 1024 * 1024;
const MAX_SHADER_PACKAGE_BYTES = 16 * 1024 * 1024;
let installedDefinitions: readonly SceneGeneratorDefinition[] = [];
let revision = 0;

export function getSceneGeneratorDefinitions(): readonly SceneGeneratorDefinition[] {
  return installedDefinitions;
}

export function getSceneGeneratorRegistryRevision(): number {
  return revision;
}

export function findSceneGeneratorDefinition(
  pluginId: string,
  nodeType: string,
): SceneGeneratorDefinition | undefined {
  return installedDefinitions.find(
    (definition) => definition.pluginId === pluginId && definition.nodeType === nodeType,
  );
}

export function subscribeSceneGeneratorDefinitions(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function synchronizeSceneGeneratorDefinitions(status: PluginStatus): readonly Error[] {
  const failures: Error[] = [];
  const definitions: SceneGeneratorDefinition[] = [];
  const keys = new Set<string>();
  if (!status.safeMode) {
    for (const manifest of status.report.plugins) {
      if (status.disabled.includes(manifest.plugin.id)) continue;
      if (manifest.plugin.kind !== "scene_generator") continue;
      try {
        if (manifest.plugin.id.startsWith("org.aster.builtin."))
          throw new Error(`Plugin id ${manifest.plugin.id} uses the host-reserved namespace`);
        const definition = sceneGeneratorDefinitionFromManifest(
          manifest,
          status.report.shader_sources?.[manifest.plugin.id] ?? {},
        );
        const key = `${definition.pluginId}:${definition.nodeType}`;
        if (keys.has(key)) throw new Error(`Scene generator ${key} is installed more than once`);
        keys.add(key);
        definitions.push(definition);
      } catch (reason) {
        failures.push(reason instanceof Error ? reason : new Error("Invalid scene generator"));
      }
    }
  }
  definitions.sort((left, right) =>
    `${left.pluginName}\u0000${left.pluginId}\u0000${left.nodeType}`.localeCompare(
      `${right.pluginName}\u0000${right.pluginId}\u0000${right.nodeType}`,
    ),
  );
  if (
    definitions.length === installedDefinitions.length &&
    definitions.every(
      (definition, index) =>
        definition.pluginId === installedDefinitions[index].pluginId &&
        definition.nodeType === installedDefinitions[index].nodeType &&
        definition.runtimeKey === installedDefinitions[index].runtimeKey,
    )
  )
    return failures;
  installedDefinitions = definitions;
  revision += 1;
  for (const listener of listeners) listener();
  return failures;
}

export function sceneGeneratorDefinitionFromManifest(
  manifest: PluginManifest,
  shaderSources: Readonly<Record<string, string>>,
): SceneGeneratorDefinition {
  const graph = manifest.scene_generator;
  if (manifest.plugin.kind !== "scene_generator" || !graph)
    throw new Error(`Plugin ${manifest.plugin.id} is not a scene generator`);
  if (manifest.plugin.api_version !== HOST_PLUGIN_API_VERSION || graph.api_version !== 1)
    throw new Error(`Plugin ${manifest.plugin.id} uses an unsupported scene-generator API`);
  if (!isValidPluginId(manifest.plugin.id))
    throw new Error(`Plugin id ${manifest.plugin.id} must be a reverse-domain identifier`);
  if (
    manifest.plugin.name.trim().length === 0 ||
    manifest.plugin.name.length > 256 ||
    !/^\d+\.\d+\.\d+$/.test(manifest.plugin.version)
  )
    throw new Error(`Plugin ${manifest.plugin.id} has invalid display metadata`);
  assertGeneratorParameters(manifest);
  assertGraphContract(manifest, graph);
  const capacityParameter = manifest.parameters.find(
    (parameter) => parameter.name === graph.capacity_parameter,
  );
  if (!capacityParameter)
    throw new Error(`Plugin ${manifest.plugin.id} does not declare its capacity parameter`);
  if (capacityParameter.type !== "number")
    throw new Error(`Plugin ${manifest.plugin.id} capacity parameter must be a number`);
  const renderParameter = graph.render_parameter
    ? manifest.parameters.find((parameter) => parameter.name === graph.render_parameter)
    : undefined;
  if (graph.render_parameter && !renderParameter)
    throw new Error(`Plugin ${manifest.plugin.id} does not declare its render parameter`);
  if (renderParameter && renderParameter.type !== "choice")
    throw new Error(`Plugin ${manifest.plugin.id} render parameter must be a choice`);
  if (
    renderParameter?.type === "choice" &&
    graph.render_variants.some(
      (variant) =>
        !variant.selector_value || !renderParameter.choices.includes(variant.selector_value),
    )
  )
    throw new Error(`Plugin ${manifest.plugin.id} render selectors must be declared choices`);
  if (
    !Number.isInteger(graph.max_instances) ||
    graph.max_instances < 1 ||
    graph.max_instances > 1_000_000 ||
    !Number.isInteger(graph.instance_stride) ||
    graph.instance_stride < 16 ||
    graph.instance_stride > 256 ||
    graph.instance_stride % 16 !== 0
  )
    throw new Error(`Plugin ${manifest.plugin.id} exceeds scene-generator storage quotas`);
  if (graph.compute_passes.length < 1 || graph.compute_passes.length > 8)
    throw new Error(`Plugin ${manifest.plugin.id} has an invalid compute-pass count`);
  if (graph.render_variants.length < 1 || graph.render_variants.length > 8)
    throw new Error(`Plugin ${manifest.plugin.id} has an invalid render-variant count`);
  const requiredShaders = new Set([
    ...graph.compute_passes.map((pass) => pass.shader),
    ...graph.render_variants.flatMap((variant) => [
      variant.shader,
      ...(variant.auxiliary ? [variant.auxiliary.shader] : []),
    ]),
  ]);
  let shaderBytes = 0;
  const encoder = new TextEncoder();
  for (const path of requiredShaders) {
    const source = shaderSources[path];
    if (!source) throw new Error(`Plugin ${manifest.plugin.id} is missing runtime shader ${path}`);
    const sourceBytes = encoder.encode(source).byteLength;
    if (sourceBytes > MAX_SHADER_BYTES)
      throw new Error(`Plugin ${manifest.plugin.id} runtime shader ${path} exceeds its size limit`);
    shaderBytes += sourceBytes;
    if (shaderBytes > MAX_SHADER_PACKAGE_BYTES)
      throw new Error(`Plugin ${manifest.plugin.id} runtime shaders exceed the package size limit`);
  }
  const undeclaredShader = Object.keys(shaderSources).find((path) => !requiredShaders.has(path));
  if (undeclaredShader)
    throw new Error(
      `Plugin ${manifest.plugin.id} exposes undeclared runtime shader ${undeclaredShader}`,
    );
  if (manifest.parameters.some((parameter) => parameter.type === "texture"))
    throw new Error(`Plugin ${manifest.plugin.id} uses unsupported scene-generator texture input`);
  const definition = {
    pluginId: manifest.plugin.id,
    pluginName: manifest.plugin.name,
    pluginVersion: manifest.plugin.version,
    nodeType: graph.node_type,
    apiVersion: graph.api_version,
    parameters: manifest.parameters,
    graph,
    shaderSources,
  };
  return {
    ...definition,
    runtimeKey: contentFingerprint(definition),
  };
}

function assertGeneratorParameters(manifest: PluginManifest): void {
  if (manifest.parameters.length > 128)
    throw new Error(`Plugin ${manifest.plugin.id} declares too many parameters`);
  const names = new Set<string>();
  for (const parameter of manifest.parameters) {
    if (
      !isIdentifier(parameter.name) ||
      names.has(parameter.name) ||
      parameter.label.trim().length === 0 ||
      parameter.label.length > 256
    )
      throw new Error(`Plugin ${manifest.plugin.id} has an invalid parameter schema`);
    names.add(parameter.name);
    const valid = (() => {
      switch (parameter.type) {
        case "number":
          return (
            Number.isFinite(parameter.default) &&
            Number.isFinite(parameter.min) &&
            Number.isFinite(parameter.max) &&
            parameter.min <= parameter.default &&
            parameter.default <= parameter.max
          );
        case "color":
          return (
            parameter.default.length === 4 &&
            parameter.default.every(
              (channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1,
            )
          );
        case "vector":
          return (
            parameter.default.length >= 2 &&
            parameter.default.length <= 4 &&
            Number.isFinite(parameter.min) &&
            Number.isFinite(parameter.max) &&
            parameter.min <= parameter.max &&
            parameter.default.every(
              (channel) =>
                Number.isFinite(channel) && channel >= parameter.min && channel <= parameter.max,
            )
          );
        case "choice":
          return (
            parameter.choices.length > 0 &&
            parameter.choices.length <= 256 &&
            new Set(parameter.choices).size === parameter.choices.length &&
            parameter.choices.includes(parameter.default) &&
            parameter.choices.every((choice) => choice.trim().length > 0 && choice.length <= 128)
          );
        case "texture":
          return true;
      }
    })();
    if (!valid) throw new Error(`Plugin ${manifest.plugin.id} has an invalid parameter schema`);
  }
}

function assertGraphContract(manifest: PluginManifest, graph: SceneGeneratorGraph): void {
  const pluginId = manifest.plugin.id;
  if (
    !manifest.capabilities.includes("gpu_compute") ||
    !manifest.capabilities.includes("gpu_render")
  )
    throw new Error(`Plugin ${pluginId} requires GPU compute and render capabilities`);
  if (
    !isIdentifier(graph.node_type) ||
    !isIdentifier(graph.capacity_parameter) ||
    (graph.render_parameter !== undefined && !isIdentifier(graph.render_parameter))
  )
    throw new Error(`Plugin ${pluginId} has invalid graph identifiers`);
  if (
    !Number.isInteger(graph.max_instances) ||
    graph.max_instances < 1 ||
    graph.max_instances > 1_000_000 ||
    !Number.isInteger(graph.instance_stride) ||
    graph.instance_stride < 16 ||
    graph.instance_stride > 256 ||
    graph.instance_stride % 16 !== 0 ||
    graph.max_instances * graph.instance_stride > 512 * 1024 * 1024
  )
    throw new Error(`Plugin ${pluginId} exceeds scene-generator storage quotas`);
  if (graph.compute_passes.length < 1 || graph.compute_passes.length > 8)
    throw new Error(`Plugin ${pluginId} has an invalid compute-pass count`);
  if (graph.render_variants.length < 1 || graph.render_variants.length > 8)
    throw new Error(`Plugin ${pluginId} has an invalid render-variant count`);
  const ids = new Set<string>();
  for (const pass of graph.compute_passes) {
    const workgroupSize = pass.workgroup_size;
    if (
      !isIdentifier(pass.id) ||
      !isIdentifier(pass.entry_point) ||
      !isShaderPath(pass.shader) ||
      !Array.isArray(workgroupSize) ||
      workgroupSize.length !== 3 ||
      workgroupSize.some((value) => !Number.isInteger(value) || value < 1 || value > 256) ||
      workgroupSize[0] * workgroupSize[1] * workgroupSize[2] > 256 ||
      ids.has(pass.id)
    )
      throw new Error(`Plugin ${pluginId} has an invalid compute pass`);
    ids.add(pass.id);
  }
  const selectors = new Set<string>();
  const computeShaders = new Set(graph.compute_passes.map((pass) => pass.shader));
  for (const variant of graph.render_variants) {
    if (
      !isIdentifier(variant.id) ||
      !isIdentifier(variant.vertex_entry) ||
      !isIdentifier(variant.fragment_entry) ||
      !isShaderPath(variant.shader) ||
      !Number.isInteger(variant.vertex_count) ||
      variant.vertex_count < 1 ||
      variant.vertex_count > 65_535 ||
      ids.has(variant.id) ||
      (variant.auxiliary !== undefined &&
        (!isShaderPath(variant.auxiliary.shader) ||
          !isIdentifier(variant.auxiliary.vertex_entry) ||
          !isIdentifier(variant.auxiliary.fragment_entry)))
    )
      throw new Error(`Plugin ${pluginId} has an invalid render variant`);
    if (
      computeShaders.has(variant.shader) ||
      (variant.auxiliary && computeShaders.has(variant.auxiliary.shader))
    )
      throw new Error(
        `Plugin ${pluginId} must keep compute and render shaders in separate modules`,
      );
    ids.add(variant.id);
    if (graph.render_parameter) {
      if (!variant.selector_value || selectors.has(variant.selector_value))
        throw new Error(`Plugin ${pluginId} has invalid render selectors`);
      selectors.add(variant.selector_value);
    } else if (variant.selector_value !== undefined) {
      throw new Error(`Plugin ${pluginId} has selectors without a render parameter`);
    }
  }
}

export function createSceneGeneratorInstance(
  definition: SceneGeneratorDefinition,
): SceneGeneratorInstance {
  const parameters: Record<string, SceneGeneratorParameterValue> = {};
  for (const parameter of definition.parameters) {
    const value = defaultParameterValue(parameter);
    if (value !== undefined) parameters[parameter.name] = value;
  }
  const instance: SceneGeneratorInstance = {
    pluginId: definition.pluginId,
    nodeType: definition.nodeType,
    apiVersion: definition.apiVersion,
    parameters,
  };
  assertSceneGeneratorInstance(instance);
  return instance;
}

function defaultParameterValue(
  parameter: PluginParameter,
): SceneGeneratorParameterValue | undefined {
  switch (parameter.type) {
    case "number":
    case "choice":
      return parameter.default;
    case "color":
    case "vector":
      return [...parameter.default];
    case "texture":
      return undefined;
  }
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
}

function isShaderPath(value: string): boolean {
  return (
    value.endsWith(".wgsl") &&
    !/^(?:[A-Za-z]:|[\\/])/.test(value) &&
    value
      .split(/[\\/]/)
      .every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function isValidPluginId(id: string): boolean {
  const labels = id.split(".");
  return (
    id.length <= 128 &&
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  );
}

function contentFingerprint(value: unknown): string {
  const serialized = stableSerialize(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
    second = ((second << 13) | (second >>> 19)) >>> 0;
  }
  return `${serialized.length.toString(16)}-${first.toString(16).padStart(8, "0")}-${second
    .toString(16)
    .padStart(8, "0")}`;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
