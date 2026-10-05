import { BLEND_MODES, type BlendMode } from "../../core/types";
import { validateGeneratorGraph } from "../scene/scene-generator-program";
import { hash, integer, object, requirePlan } from "./canonical";
import { compositionIdentityToString } from "./composition-identity";
import type { GeneratorProgramRecord, SceneGeneratorSlice } from "./generator-types";
import type { BlobDescriptor } from "./types";

export const GENERATOR_FIELDS = [
  "kind",
  "blob_index",
  "instance_id",
  "selection_id",
  "blend_mode",
  "program",
  "variant_index",
  "requested_count",
  "effective_count",
  "capacity",
  "dispatches",
  "has_audio",
];
export function generatorRuntimeGraph(program: GeneratorProgramRecord) {
  return {
    ...structuredClone(program.graph),
    render_variants: program.graph.render_variants.map((v) => {
      const { auxiliary, ...draw } = structuredClone(v);
      return { ...draw, ...(auxiliary ? { auxiliary } : {}) };
    }),
  };
}
export function validateGeneratorSlice(
  value: unknown,
  blob: BlobDescriptor,
  resources: readonly string[],
) {
  const s = object(value, GENERATOR_FIELDS);
  requirePlan(s.kind === "scene_generator", "invalid_generator", "Unknown generator slice");
  compositionIdentityToString(s.instance_id);
  compositionIdentityToString(s.selection_id);
  requirePlan(
    BLEND_MODES.includes(s.blend_mode as BlendMode) && typeof s.has_audio === "boolean",
    "invalid_generator",
    "Invalid generator flags",
  );
  const p = object(s.program, ["source_key", "label", "audio_analysis", "graph"]);
  compositionIdentityToString(p.source_key);
  compositionIdentityToString(p.label);
  requirePlan(
    typeof p.audio_analysis === "boolean" && (!s.has_audio || p.audio_analysis),
    "invalid_generator",
    "Invalid audio capability",
  );
  const g = object(p.graph, [
    "api_version",
    "max_instances",
    "instance_stride",
    "compute_passes",
    "render_variants",
  ]);
  requirePlan(
    Array.isArray(g.compute_passes) && Array.isArray(g.render_variants),
    "invalid_generator",
    "Invalid generator graph arrays",
  );
  for (const value of g.compute_passes) {
    const pass = object(value, ["id", "shader", "entry_point", "workgroup_size", "phase"]);
    requirePlan(
      typeof pass.id === "string" &&
        typeof pass.entry_point === "string" &&
        Array.isArray(pass.workgroup_size),
      "invalid_generator",
      "Invalid compute fields",
    );
    hash(pass.shader);
  }
  for (const value of g.render_variants) {
    const v = object(value, [
      "id",
      "shader",
      "vertex_entry",
      "fragment_entry",
      "vertex_count",
      "blend",
      "depth",
      "cull",
      "auxiliary",
    ]);
    requirePlan(
      typeof v.id === "string" &&
        typeof v.vertex_entry === "string" &&
        typeof v.fragment_entry === "string",
      "invalid_generator",
      "Invalid render fields",
    );
    hash(v.shader);
    if (v.auxiliary !== null) {
      const a = object(v.auxiliary, ["shader", "vertex_entry", "fragment_entry"]);
      requirePlan(
        typeof a.vertex_entry === "string" && typeof a.fragment_entry === "string",
        "invalid_generator",
        "Invalid auxiliary fields",
      );
      hash(a.shader);
    }
  }
  const slice = value as SceneGeneratorSlice;
  const graph = generatorRuntimeGraph(slice.program);
  const required = validateGeneratorGraph(graph);
  requirePlan(
    resources.length === required.size,
    "invalid_generator",
    "Unexpected generator resource reference",
  );
  for (const h of required)
    requirePlan(resources.includes(h), "missing_resource", "Undeclared generator shader");
  const selected = integer(s.variant_index, 0, graph.render_variants.length - 1);
  const count = integer(s.effective_count, 1, integer(s.requested_count, 1, graph.max_instances));
  integer(s.capacity, count, graph.max_instances);
  requirePlan(
    Array.isArray(s.dispatches) && s.dispatches.length === graph.compute_passes.length,
    "invalid_generator",
    "Missing generator dispatches",
  );
  s.dispatches.forEach((d, i) => {
    requirePlan(
      Array.isArray(d) &&
        d.length === 3 &&
        d[0] === Math.ceil(count / graph.compute_passes[i].workgroup_size[0]) &&
        d[1] === 1 &&
        d[2] === 1,
      "invalid_generator",
      "Invalid generator dispatch",
    );
  });
  const length = s.has_audio ? 11552 : 2272;
  requirePlan(
    blob.element_type === "u8" && blob.byte_length === length && blob.element_count === length,
    "invalid_generator",
    "Invalid generator payload layout",
  );
  return graph.render_variants[selected].vertex_count;
}
export function validateGeneratorBlob(bytes: Uint8Array, s: SceneGeneratorSlice) {
  requirePlan(
    bytes.length === (s.has_audio ? 11552 : 2272),
    "invalid_generator",
    "Invalid generator payload length",
  );
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  requirePlan(
    v.getUint32(24, true) === s.effective_count &&
      v.getUint32(2256, true) === s.program.graph.render_variants[s.variant_index].vertex_count &&
      [2260, 2264, 2268].every((o) => v.getUint32(o, true) === 0),
    "invalid_generator",
    "Generator count payload mismatch",
  );
}
