import type {
  AuxiliaryBufferKind,
  DepthEffectVisualization,
  SurfaceEffectVisualization,
} from "../gpu/render-buffers";
import { object, requirePlan } from "./canonical";
import type { BlobDescriptor } from "./types";

export type FinalOutputRoute =
  | { kind: "beauty"; source: "scene" | "motion_blur" }
  | { kind: "depth"; mode: DepthEffectVisualization }
  | { kind: "surface"; mode: SurfaceEffectVisualization }
  | { kind: "visualizer"; mode: AuxiliaryBufferKind | "linearColor" | "luminance" | "alpha" };
export interface FinalOutputSlice {
  kind: "final_output";
  blob_index: number;
  route: FinalOutputRoute;
}
export function validateFinalOutput(value: unknown, blob: BlobDescriptor): void {
  const slice = object(value, ["kind", "blob_index", "route"]);
  requirePlan(slice.kind === "final_output", "unknown_variant", "Unknown output slice");
  const kind = (slice.route as Record<string, unknown>)?.kind;
  const route = object(slice.route, ["kind", kind === "beauty" ? "source" : "mode"]);
  const modes: Record<string, readonly string[]> = {
    beauty: ["scene", "motion_blur"],
    depth: ["depthFog", "depthOfField"],
    surface: ["selectionIsolation", "vectorMotionBlur"],
    visualizer: [
      "linearColor",
      "luminance",
      "alpha",
      "normal",
      "objectId",
      "materialId",
      "worldPosition",
      "motionVector",
    ],
  };
  requirePlan(
    typeof kind === "string" &&
      Object.keys(modes).includes(kind) &&
      modes[kind].includes(String(kind === "beauty" ? route.source : route.mode)),
    "invalid_header",
    "Invalid final output route",
  );
  requirePlan(
    blob.element_type === "f32_le" && blob.element_count === 4 && blob.byte_length === 16,
    "invalid_header",
    "Invalid output clear layout",
  );
}
export function validateFinalOutputBlob(bytes: Uint8Array): void {
  requirePlan(bytes.length === 16, "invalid_header", "Invalid output clear payload");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < 4; i++) {
    const value = view.getFloat32(i * 4, true);
    requirePlan(
      Number.isFinite(value) && value >= 0 && value <= 1,
      "invalid_header",
      "Invalid output clear color",
    );
  }
}
