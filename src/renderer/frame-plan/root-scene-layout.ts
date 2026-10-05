import { BLEND_MODES, type BlendMode } from "../../core/types";
import { hash, integer, object, requirePlan } from "./canonical";
import { compositionIdentityToString } from "./composition-identity";
import type { RootSceneCommandsSlice } from "./root-scene-types";
import type { BlobDescriptor, PlanSlice } from "./types";

export const ROOT_SCENE_FIELDS = ["kind", "blob_index", "draws", "commands"];

export function validateRootScene(
  value: unknown,
  blob: BlobDescriptor,
  slices: readonly PlanSlice[],
  resources: readonly string[],
) {
  requirePlan(Array.isArray(resources), "invalid_root_scene", "Invalid root resources");
  const root = object(value, ROOT_SCENE_FIELDS);
  requirePlan(
    Array.isArray(root.draws) && Array.isArray(root.commands),
    "invalid_root_scene",
    "Invalid root arrays",
  );
  requirePlan(
    root.commands.length > 0 && root.commands.length <= 65536 && root.draws.length <= 65536,
    "invalid_root_scene",
    "Excessive root commands or draws",
  );
  const typedSlice = (index: unknown, kind: PlanSlice["kind"]) => {
    const id = integer(index, 0, slices.length - 1);
    const slice = slices.find((s) => s.blob_index === id);
    requirePlan(
      slice?.kind === kind,
      "invalid_root_scene",
      "Root reference has the wrong slice type",
    );
    return slice;
  };
  const blend = (value: unknown) =>
    requirePlan(
      BLEND_MODES.includes(value as BlendMode),
      "invalid_root_scene",
      "Unknown root blend",
    );
  for (const value of root.draws) {
    const draw = object(value, [
      "instance_id",
      "first_vertex",
      "vertex_count",
      "blend_mode",
      "texture",
      "material_blob_index",
    ]);
    compositionIdentityToString(draw.instance_id);
    const first = integer(draw.first_vertex, 0, 0xffff_ffff);
    integer(draw.vertex_count, 0, 0xffff_ffff - first);
    blend(draw.blend_mode);
    const texture = draw.texture as Record<string, unknown>;
    requirePlan(
      texture && typeof texture === "object",
      "invalid_root_scene",
      "Invalid root texture",
    );
    if (texture.kind === "none" || texture.kind === "pending") object(texture, ["kind"]);
    else if (texture.kind === "media") {
      object(texture, ["kind", "hash"]);
      hash(texture.hash);
      requirePlan(
        resources.includes(texture.hash as string),
        "missing_resource",
        "Undeclared root media",
      );
    } else {
      object(texture, ["kind", "instance_id"]);
      requirePlan(
        texture.kind === "surface" || texture.kind === "raster_cache",
        "invalid_root_scene",
        "Unknown root texture",
      );
      compositionIdentityToString(texture.instance_id);
    }
    if (draw.material_blob_index !== null) typedSlice(draw.material_blob_index, "material_binding");
  }
  let pass: "scene" | "layer" | undefined;
  let layerId: string | undefined;
  let clearCount = 0;
  for (const [index, value] of root.commands.entries()) {
    requirePlan(value && typeof value === "object", "invalid_root_scene", "Invalid root command");
    const command = value as Record<string, unknown>;
    if (command.kind === "begin_scene") {
      object(command, [
        "kind",
        "group",
        "color_load",
        "color_store",
        "depth_load",
        "depth_store",
        "clear_index",
      ]);
      requirePlan(
        !pass && ["composition", "geometry", "generator"].includes(String(command.group)),
        "invalid_root_scene",
        "Overlapping root pass",
      );
      requirePlan(
        (command.group === "composition") === (index === 0),
        "invalid_root_scene",
        "Root composition must begin first",
      );
      requirePlan(
        ["clear", "load"].includes(String(command.color_load)) &&
          ["clear", "load"].includes(String(command.depth_load)) &&
          ["store", "discard"].includes(String(command.color_store)) &&
          ["store", "discard"].includes(String(command.depth_store)),
        "invalid_root_scene",
        "Invalid root attachment operation",
      );
      requirePlan(
        index !== 0 || (command.color_load === "clear" && command.depth_load === "clear"),
        "invalid_root_scene",
        "Root targets must initialize",
      );
      requirePlan(
        integer(command.clear_index) === clearCount++,
        "invalid_root_scene",
        "Clear payload order differs",
      );
      pass = "scene";
    } else if (command.kind === "end_scene" || command.kind === "finish_layer") {
      object(command, ["kind"]);
      requirePlan(
        pass === (command.kind === "end_scene" ? "scene" : "layer"),
        "invalid_root_scene",
        "Unmatched pass end",
      );
      pass = undefined;
      layerId = undefined;
    } else if (command.kind === "begin_layer" || command.kind === "adjustment") {
      object(command, ["kind", "effect_blob_index"]);
      requirePlan(index > 0 && !pass, "invalid_root_scene", "Overlapping effect operation");
      const effect = typedSlice(command.effect_blob_index, "effect_execution");
      requirePlan(
        effect.kind === "effect_execution" &&
          effect.route === (command.kind === "begin_layer" ? "layer" : "adjustment"),
        "invalid_root_scene",
        "Wrong root effect route",
      );
      if (command.kind === "begin_layer") {
        pass = "layer";
        layerId = compositionIdentityToString(effect.instance_id);
      }
    } else {
      requirePlan(
        command.kind === "geometry" || command.kind === "generator",
        "invalid_root_scene",
        "Unknown root command",
      );
      object(
        command,
        command.kind === "geometry"
          ? ["kind", "draw_index", "blend_mode"]
          : ["kind", "instance_id", "blend_mode"],
      );
      blend(command.blend_mode);
      requirePlan(
        pass &&
          (pass === "layer"
            ? command.blend_mode === "normal"
            : ["normal", "add", "screen"].includes(String(command.blend_mode))),
        "invalid_root_scene",
        "Draw lacks a compatible pass",
      );
      const id =
        command.kind === "geometry"
          ? (
              root.draws[integer(command.draw_index, 0, root.draws.length - 1)] as Record<
                string,
                unknown
              >
            ).instance_id
          : command.instance_id;
      const identity = compositionIdentityToString(id);
      requirePlan(
        pass !== "layer" || identity === layerId,
        "invalid_root_scene",
        "Isolated draw identity differs",
      );
    }
  }
  requirePlan(
    !pass &&
      clearCount > 0 &&
      blob.element_type === "u8" &&
      blob.byte_length === clearCount * 40 &&
      blob.element_count === blob.byte_length,
    "invalid_root_scene",
    "Open root pass or invalid clear payload",
  );
  return root as unknown as RootSceneCommandsSlice;
}

export function validateRootSceneBlob(bytes: Uint8Array) {
  requirePlan(
    bytes.byteLength > 0 && bytes.byteLength % 40 === 0,
    "invalid_root_scene",
    "Invalid clear bytes",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.byteLength; offset += 8) {
    const value = view.getFloat64(offset, true);
    requirePlan(
      Number.isFinite(value) && (offset % 40 !== 32 || (value >= 0 && value <= 1)),
      "invalid_root_scene",
      "Invalid clear value",
    );
  }
}
