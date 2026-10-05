import type { BlendMode } from "../../core/types";
import type { CompositionIdentity } from "./types";

export type RootTextureReference =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "media"; hash: string }
  | { kind: "surface" | "raster_cache"; instance_id: CompositionIdentity };

export interface RootDrawRecord {
  instance_id: CompositionIdentity;
  first_vertex: number;
  vertex_count: number;
  blend_mode: BlendMode;
  texture: RootTextureReference;
  material_blob_index: number | null;
}

export type RootCommandRecord =
  | {
      kind: "begin_scene";
      group: "composition" | "generator" | "geometry";
      color_load: GPULoadOp;
      color_store: GPUStoreOp;
      depth_load: GPULoadOp;
      depth_store: GPUStoreOp;
      clear_index: number;
    }
  | { kind: "end_scene" }
  | { kind: "finish_layer" }
  | { kind: "begin_layer"; effect_blob_index: number }
  | { kind: "adjustment"; effect_blob_index: number }
  | { kind: "geometry"; draw_index: number; blend_mode: BlendMode }
  | { kind: "generator"; instance_id: CompositionIdentity; blend_mode: BlendMode };

export interface RootSceneCommandsSlice {
  kind: "root_scene_commands";
  blob_index: number;
  draws: RootDrawRecord[];
  commands: RootCommandRecord[];
}
