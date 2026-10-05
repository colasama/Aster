import type {
  SceneGeneratorComputePass,
  SceneGeneratorRenderVariant,
} from "../../core/plugins/plugins";
import type { BlendMode } from "../../core/types";
import type { CompositionIdentity } from "./types";
export interface GeneratorProgramRecord {
  source_key: CompositionIdentity;
  label: CompositionIdentity;
  audio_analysis: boolean;
  graph: {
    api_version: number;
    max_instances: number;
    instance_stride: number;
    compute_passes: SceneGeneratorComputePass[];
    render_variants: (Omit<SceneGeneratorRenderVariant, "selector_value" | "auxiliary"> & {
      auxiliary: NonNullable<SceneGeneratorRenderVariant["auxiliary"]> | null;
    })[];
  };
}
export interface SceneGeneratorSlice {
  kind: "scene_generator";
  blob_index: number;
  instance_id: CompositionIdentity;
  selection_id: CompositionIdentity;
  blend_mode: BlendMode;
  program: GeneratorProgramRecord;
  variant_index: number;
  requested_count: number;
  effective_count: number;
  capacity: number;
  dispatches: [number, number, number][];
  has_audio: boolean;
}
