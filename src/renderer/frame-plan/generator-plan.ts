import {
  type SceneGeneratorPlan,
  validateGeneratorInvocation,
} from "../scene/scene-generator-plan";
import {
  type GeneratorShaderResource,
  generatorProgramKey,
  readGeneratorShaders,
} from "../scene/scene-generator-program";
import { requirePlan } from "./canonical";
import {
  compositionIdentityFromString as identity,
  compositionIdentityToString as text,
} from "./composition-identity";
import { generatorRuntimeGraph } from "./generator-layout";
import { defaultFramePlanLimits, type FrameHeaderSlice, type FramePlanSliceData } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";
export function buildGeneratorSlice(
  header: FrameHeaderSlice,
  plan: SceneGeneratorPlan,
): FramePlanSliceData {
  validateGeneratorInvocation(plan);
  const bytes = new Uint8Array(plan.audio ? 11552 : 2272);
  bytes.set(plan.context);
  bytes.set(plan.parameters, 208);
  bytes.set(plan.indirect, 2256);
  if (plan.audio) bytes.set(plan.audio, 2272);
  const program = plan.program;
  const metadata = validateMetadata(
    {
      kind: "frame_plan_slice",
      plan_version: 1,
      contract_level: "scene_generator_slice_v1",
      renderer_plan_complete: false,
      header: structuredClone(header),
      resources: program.shaders.map((r) => r.message.hash).sort(),
      blobs: [
        {
          byte_offset: 0,
          byte_length: bytes.length,
          element_type: "u8",
          element_count: bytes.length,
        },
      ],
      slices: [
        {
          kind: "scene_generator",
          blob_index: 0,
          instance_id: identity(plan.instanceId),
          selection_id: identity(plan.selectionId),
          blend_mode: plan.blendMode,
          program: {
            source_key: identity(program.sourceKey),
            label: identity(program.label),
            audio_analysis: program.audioAnalysis,
            graph: {
              ...structuredClone(program.graph),
              render_variants: program.graph.render_variants.map((v) => ({
                ...structuredClone(v),
                auxiliary: v.auxiliary ? structuredClone(v.auxiliary) : null,
              })),
            },
          },
          variant_index: plan.variantIndex,
          requested_count: plan.requestedCount,
          effective_count: plan.effectiveCount,
          capacity: plan.capacity,
          dispatches: structuredClone(plan.dispatches),
          has_audio: plan.audio !== undefined,
        },
      ],
    },
    defaultFramePlanLimits(),
  );
  validatePlanBlob(bytes, metadata, 0);
  return { metadata, blobs: [bytes] };
}
export function readGeneratorSlice(
  input: FramePlanSliceData,
  resources: ReadonlyMap<string, GeneratorShaderResource>,
): SceneGeneratorPlan {
  const metadata = validateMetadata(input.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.contract_level === "scene_generator_slice_v1" &&
      metadata.slices.length === 1 &&
      input.blobs.length === 1,
    "invalid_generator",
    "Expected one generator slice",
  );
  const s = metadata.slices[0];
  requirePlan(s.kind === "scene_generator", "invalid_generator", "Missing generator slice");
  const bytes = input.blobs[s.blob_index];
  validatePlanBlob(bytes, metadata, s.blob_index);
  const shaders = metadata.resources.map((hash) => {
    const r = resources.get(hash);
    requirePlan(
      r && r.message.hash === hash,
      "missing_resource",
      "Missing supplied generator shader",
    );
    return r;
  });
  const description = {
    sourceKey: text(s.program.source_key),
    label: text(s.program.label),
    audioAnalysis: s.program.audio_analysis,
    graph: generatorRuntimeGraph(s.program),
    shaders,
  };
  const program = { ...description, key: generatorProgramKey(description) };
  const plan = {
    instanceId: text(s.instance_id),
    selectionId: text(s.selection_id),
    blendMode: s.blend_mode,
    program,
    variantIndex: s.variant_index,
    requestedCount: s.requested_count,
    effectiveCount: s.effective_count,
    capacity: s.capacity,
    dispatches: structuredClone(s.dispatches),
    context: new Uint8Array(bytes.subarray(0, 208)),
    parameters: new Uint8Array(bytes.subarray(208, 2256)),
    indirect: new Uint8Array(bytes.subarray(2256, 2272)),
    ...(s.has_audio ? { audio: new Uint8Array(bytes.subarray(2272)) } : {}),
  };
  validateGeneratorInvocation(plan);
  return plan;
}
/** Explicit resource-ingestion check, separate from reuse of already validated GPU pipelines. */
export function validateGeneratorResources(plan: SceneGeneratorPlan): void {
  readGeneratorShaders(plan.program);
}
