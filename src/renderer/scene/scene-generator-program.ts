import type { SceneGeneratorGraph } from "../../core/plugins/plugins";
import type { SceneGeneratorDefinition } from "../../core/scene/scene-generator-registry";
import { canonicalJson } from "../frame-plan/canonical";
import { contentResourceHashSync } from "../frame-plan/resources";
import type { PutResource } from "../frame-plan/types";

export interface GeneratorShaderResource {
  message: Extract<PutResource, { kind: "buffer" }>;
  bytes: Uint8Array;
}
export interface GeneratorProgramPlan {
  key: string;
  sourceKey: string;
  label: string;
  audioAnalysis: boolean;
  graph: Pick<
    SceneGeneratorGraph,
    "api_version" | "max_instances" | "instance_stride" | "compute_passes" | "render_variants"
  >;
  shaders: GeneratorShaderResource[];
}
export function generatorDefinitionKey(definition: SceneGeneratorDefinition): string {
  return `${definition.pluginId}:${definition.nodeType}:${definition.runtimeKey}`;
}
function shaderResource(bytes: Uint8Array): GeneratorShaderResource {
  const content = {
    kind: "buffer" as const,
    descriptor: {
      element_type: "u8" as const,
      element_count: bytes.length,
      byte_length: bytes.length,
    },
  };
  return {
    message: { type: "put_resource", ...content, hash: contentResourceHashSync(content, bytes) },
    bytes,
  };
}
export function generatorProgramKey(program: Omit<GeneratorProgramPlan, "key">): string {
  return shaderResource(
    new TextEncoder().encode(
      canonicalJson({
        sourceKey: program.sourceKey,
        label: program.label,
        audioAnalysis: program.audioAnalysis,
        graph: program.graph,
      }),
    ),
  ).message.hash;
}
/** Snapshots executable descriptors; shader paths are replaced by content identities. */
export function buildGeneratorProgram(definition: SceneGeneratorDefinition): GeneratorProgramPlan {
  const shaders = new Map<string, GeneratorShaderResource>();
  const reference = (path: string) => {
    const source = definition.shaderSources[path];
    if (!source) throw Error(`Runtime shader ${path} is unavailable`);
    const resource = shaderResource(new TextEncoder().encode(source));
    shaders.set(resource.message.hash, resource);
    return resource.message.hash;
  };
  const graph = {
    api_version: definition.apiVersion,
    max_instances: definition.graph.max_instances,
    instance_stride: definition.graph.instance_stride,
    compute_passes: definition.graph.compute_passes.map((pass) => ({
      ...structuredClone(pass),
      shader: reference(pass.shader),
    })),
    render_variants: definition.graph.render_variants.map((variant) => {
      const { selector_value: _selector, auxiliary, ...draw } = variant;
      return {
        ...structuredClone(draw),
        shader: reference(variant.shader),
        ...(auxiliary ? { auxiliary: { ...auxiliary, shader: reference(auxiliary.shader) } } : {}),
      };
    }),
  };
  const program = {
    sourceKey: generatorDefinitionKey(definition),
    label: definition.pluginName,
    audioAnalysis: definition.audioAnalysis,
    graph,
    shaders: Array.from(shaders.values()).sort((a, b) =>
      a.message.hash.localeCompare(b.message.hash),
    ),
  };
  return { ...program, key: generatorProgramKey(program) };
}
/** Ingest resources before GPU side effects; cached compiled programs already own validated code. */
export function readGeneratorShaders(program: GeneratorProgramPlan): ReadonlyMap<string, string> {
  if (program.key !== generatorProgramKey(program))
    throw Error("Generator program identity mismatch");
  const required = validateGeneratorGraph(program.graph);
  const code = new Map<string, string>();
  let total = 0;
  for (const shader of program.shaders) {
    const m = shader.message;
    total += shader.bytes.byteLength;
    if (
      m.type !== "put_resource" ||
      m.kind !== "buffer" ||
      m.descriptor.element_type !== "u8" ||
      shader.bytes.length < 1 ||
      shader.bytes.length > 4 * 1024 * 1024 ||
      total > 16 * 1024 * 1024 ||
      !required.has(m.hash) ||
      code.has(m.hash) ||
      contentResourceHashSync(m, shader.bytes) !== m.hash
    )
      throw Error("Invalid generator shader resource");
    code.set(m.hash, new TextDecoder("utf-8", { fatal: true }).decode(shader.bytes));
  }
  if (code.size !== required.size) throw Error("Missing generator shader resource");
  return code;
}

export function validateGeneratorGraph(graph: GeneratorProgramPlan["graph"]): ReadonlySet<string> {
  if (
    graph.api_version !== 1 ||
    !Number.isInteger(graph.max_instances) ||
    graph.max_instances < 1 ||
    graph.max_instances > 1_000_000 ||
    !Number.isInteger(graph.instance_stride) ||
    graph.instance_stride < 16 ||
    graph.instance_stride > 256 ||
    graph.instance_stride % 16 !== 0 ||
    graph.compute_passes.length < 1 ||
    graph.compute_passes.length > 8 ||
    graph.render_variants.length < 1 ||
    graph.render_variants.length > 8
  )
    throw Error("Invalid generator executable bounds");
  const identifier = (v: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
  const required = new Set<string>();
  const ids = new Set<string>();
  for (const pass of graph.compute_passes) {
    const w = pass.workgroup_size;
    if (
      !identifier(pass.id) ||
      !identifier(pass.entry_point) ||
      ids.has(pass.id) ||
      w.length !== 3 ||
      w.some((n) => !Number.isInteger(n) || n < 1 || n > 256) ||
      w[0] * w[1] * w[2] > 256 ||
      !["simulation", "pre_render"].includes(pass.phase)
    )
      throw Error("Invalid generator compute descriptor");
    ids.add(pass.id);
    required.add(pass.shader);
  }
  for (const v of graph.render_variants) {
    if (
      !identifier(v.id) ||
      !identifier(v.vertex_entry) ||
      !identifier(v.fragment_entry) ||
      ids.has(v.id) ||
      !Number.isInteger(v.vertex_count) ||
      v.vertex_count < 1 ||
      v.vertex_count > 65_535 ||
      !["normal", "add", "multiply", "screen", "overlay", "layer"].includes(v.blend) ||
      !["none", "read", "read_write"].includes(v.depth) ||
      !["none", "front", "back"].includes(v.cull)
    )
      throw Error("Invalid generator render descriptor");
    ids.add(v.id);
    required.add(v.shader);
    if (v.auxiliary) {
      if (!identifier(v.auxiliary.vertex_entry) || !identifier(v.auxiliary.fragment_entry))
        throw Error("Invalid generator auxiliary descriptor");
      required.add(v.auxiliary.shader);
    }
  }
  return required;
}
