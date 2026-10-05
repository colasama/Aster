import type { RootSceneCommand } from "../compositing/root-scene-commands";
import type { SceneDrawPlan } from "../scene/scene-draw-plan";
import { align16, requirePlan } from "./canonical";
import {
  compositionIdentityFromString as identity,
  compositionIdentityToString as text,
} from "./composition-identity";
import { buildEffectExecutionSlice, readEffectExecutionSlice } from "./effect-execution-plan";
import { buildMaterialBindingSlice, readMaterialBindingSlice } from "./material-binding-plan";
import type {
  RootCommandRecord,
  RootDrawRecord,
  RootSceneCommandsSlice,
  RootTextureReference,
} from "./root-scene-types";
import {
  defaultFramePlanLimits,
  type FrameHeaderSlice,
  type FramePlanSliceData,
  type FramePlanSliceV1,
} from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

export function buildRootScenePlan(
  header: FrameHeaderSlice,
  commands: readonly RootSceneCommand[],
  draws: readonly SceneDrawPlan[],
): FramePlanSliceData {
  const bytes = new Uint8Array(commands.filter((c) => c.kind === "begin_scene").length * 40);
  const view = new DataView(bytes.buffer);
  const root: RootSceneCommandsSlice = {
    kind: "root_scene_commands",
    blob_index: 0,
    commands: [],
    draws: [],
  };
  const metadata: FramePlanSliceV1 = {
    kind: "frame_plan_slice",
    plan_version: 1,
    contract_level: "root_scene_commands_slice_v1",
    renderer_plan_complete: false,
    header: structuredClone(header),
    resources: [],
    blobs: [
      {
        byte_offset: 0,
        byte_length: bytes.length,
        element_type: "u8",
        element_count: bytes.length,
      },
    ],
    slices: [root],
  };
  const blobs: Uint8Array[] = [bytes];
  const resources = new Set<string>();
  let offset = align16(bytes.length);
  const append = (input: FramePlanSliceData) => {
    const index = blobs.length;
    const blob = input.blobs[0];
    blobs.push(blob);
    metadata.blobs.push({ ...input.metadata.blobs[0], byte_offset: offset });
    metadata.slices.push({ ...input.metadata.slices[0], blob_index: index });
    for (const hash of input.metadata.resources) resources.add(hash);
    offset = align16(offset + blob.length);
    return index;
  };
  root.draws = draws.map((draw): RootDrawRecord => {
    let texture: RootTextureReference;
    switch (draw.texture.kind) {
      case "none":
        texture = { kind: "none" };
        break;
      case "media":
        if (draw.texture.hash === null) texture = { kind: "pending" };
        else {
          texture = { kind: "media", hash: draw.texture.hash };
          resources.add(draw.texture.hash);
        }
        break;
      default:
        texture = {
          kind: "surface",
          instance_id: identity(draw.texture.instanceId),
        };
    }
    return {
      instance_id: identity(draw.instanceId),
      first_vertex: draw.firstVertex,
      vertex_count: draw.vertexCount,
      blend_mode: draw.blendMode,
      texture,
      material_blob_index: draw.material
        ? append(buildMaterialBindingSlice(header, draw.material))
        : null,
    };
  });
  let clearIndex = 0;
  root.commands = commands.map((command): RootCommandRecord => {
    switch (command.kind) {
      case "begin_scene": {
        const index = clearIndex++;
        [...command.color.clearValue, command.depth.clearValue].forEach((value, lane) => {
          view.setFloat64(index * 40 + lane * 8, value, true);
        });
        return {
          kind: "begin_scene",
          group: command.group,
          color_load: command.color.loadOp,
          color_store: command.color.storeOp,
          depth_load: command.depth.loadOp,
          depth_store: command.depth.storeOp,
          clear_index: index,
        };
      }
      case "geometry":
        return { kind: "geometry", draw_index: command.drawIndex, blend_mode: command.blendMode };
      case "generator":
        return {
          kind: "generator",
          instance_id: identity(command.instanceId),
          blend_mode: command.blendMode,
        };
      case "begin_layer":
      case "adjustment":
        return {
          kind: command.kind,
          effect_blob_index: append(buildEffectExecutionSlice(header, command.effect)),
        };
      default:
        return { kind: command.kind };
    }
  });
  metadata.resources = [...resources].sort();
  validateMetadata(metadata, defaultFramePlanLimits());
  blobs.forEach((blob, index) => {
    validatePlanBlob(blob, metadata, index);
  });
  return { metadata, blobs };
}

export function readRootScenePlan(input: FramePlanSliceData): {
  commands: RootSceneCommand[];
  draws: SceneDrawPlan[];
} {
  const metadata = validateMetadata(input.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.contract_level === "root_scene_commands_slice_v1" &&
      input.blobs.length === metadata.blobs.length,
    "invalid_root_scene",
    "Expected a root scene plan",
  );
  input.blobs.forEach((blob, index) => {
    validatePlanBlob(blob, metadata, index);
  });
  const roots = metadata.slices.filter((s) => s.kind === "root_scene_commands");
  requirePlan(roots.length === 1, "invalid_root_scene", "Expected one root command stream");
  const root = roots[0];
  const bytes = input.blobs[root.blob_index];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nested = (
    index: number,
    contract: FramePlanSliceV1["contract_level"],
  ): FramePlanSliceData => {
    const slice = metadata.slices.find((s) => s.blob_index === index);
    requirePlan(slice, "invalid_root_scene", "Missing root dependency");
    return {
      metadata: {
        ...metadata,
        contract_level: contract,
        blobs: [{ ...metadata.blobs[index], byte_offset: 0 }],
        slices: [{ ...slice, blob_index: 0 }],
      },
      blobs: [input.blobs[index]],
    };
  };
  const draws = root.draws.map((draw): SceneDrawPlan => {
    const texture = draw.texture;
    return {
      instanceId: text(draw.instance_id),
      firstVertex: draw.first_vertex,
      vertexCount: draw.vertex_count,
      blendMode: draw.blend_mode,
      texture:
        texture.kind === "none"
          ? { kind: "none" }
          : texture.kind === "pending"
            ? { kind: "media", hash: null }
            : texture.kind === "media"
              ? { kind: "media", hash: texture.hash }
              : {
                  kind: "surface",
                  instanceId: text(texture.instance_id),
                },
      ...(draw.material_blob_index === null
        ? {}
        : {
            material: readMaterialBindingSlice(
              nested(draw.material_blob_index, "material_bindings_slice_v1"),
            ),
          }),
    };
  });
  const commands = root.commands.map((command): RootSceneCommand => {
    switch (command.kind) {
      case "begin_scene": {
        const values = Array.from({ length: 5 }, (_, lane) =>
          view.getFloat64(command.clear_index * 40 + lane * 8, true),
        );
        return {
          kind: "begin_scene",
          group: command.group,
          color: {
            loadOp: command.color_load,
            storeOp: command.color_store,
            clearValue: [values[0], values[1], values[2], values[3]],
          },
          depth: {
            loadOp: command.depth_load,
            storeOp: command.depth_store,
            clearValue: values[4],
          },
        };
      }
      case "geometry":
        return { kind: "geometry", drawIndex: command.draw_index, blendMode: command.blend_mode };
      case "generator":
        return {
          kind: "generator",
          instanceId: text(command.instance_id),
          blendMode: command.blend_mode,
        };
      case "begin_layer":
      case "adjustment":
        return {
          kind: command.kind,
          effect: readEffectExecutionSlice(
            nested(command.effect_blob_index, "effect_execution_slice_v1"),
          ),
        };
      default:
        return { kind: command.kind };
    }
  });
  return { commands, draws };
}
