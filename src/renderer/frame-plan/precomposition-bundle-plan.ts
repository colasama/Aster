import type { PrecompositionScenePlan } from "../compositing/precomposition-scene-plan";
import { suppliedLutResource } from "../media/lut-selection-plan";
import { type CapturedMediaPixels, validateMediaPixelPayload } from "../media/media-pixel-payload";
import { requirePlan } from "./canonical";
import { compositionIdentityFromString as identity } from "./composition-identity";
import {
  type PrecompositionBundleSlice,
  type PrecompositionEffectRecord,
  utf16Text,
} from "./precomposition-bundle-layout";
import { PrecompositionBundleResources } from "./precomposition-bundle-resources";
import { buildRootScenePlan } from "./root-scene-plan";
import { prepareSceneBuffers } from "./scene-buffer-upload";
import { defaultFramePlanLimits, type FramePlanSliceData, type PutResource } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

export function buildPrecompositionBundle(
  graph: FramePlanSliceData,
  plans: readonly PrecompositionScenePlan[],
  media: readonly PutResource[],
  pixels: readonly CapturedMediaPixels[] = [],
) {
  const resources = new PrecompositionBundleResources();
  for (const message of media) resources.add({ message, bytes: new Uint8Array() });
  const bundle: PrecompositionBundleSlice = {
    kind: "precomposition_bundle",
    blob_index: 0,
    graph: resources.addPlan(graph),
    scenes: [],
    media_pixels: [],
  };
  const mappings: number[] = [];
  for (const scene of plans) {
    const geometry = prepareSceneBuffers(scene.scene);
    const commands = buildRootScenePlan(
      scene.scene.metadata.header,
      scene.commands,
      scene.draws.map((draw) => {
        const source = geometry.draws[draw.sceneDrawIndex];
        requirePlan(source, "missing_resource", "Surface draw geometry is absent");
        mappings.push(draw.sceneDrawIndex);
        return {
          instanceId: source.instanceId,
          firstVertex: draw.firstVertex,
          vertexCount: draw.vertexCount,
          blendMode: "normal",
          texture:
            draw.texture.kind === "surface"
              ? draw.texture.targetId === null
                ? { kind: "none" }
                : { kind: "surface", instanceId: draw.texture.targetId }
              : draw.texture,
        };
      }),
    );
    const effects = [...scene.effects].map(([id, effect]): PrecompositionEffectRecord => {
      const base = { instance_id: identity(id), execution: resources.addPlan(effect.execution) };
      if (effect.status === "ready") {
        const lut = suppliedLutResource(effect.lut);
        return {
          ...base,
          status: "ready",
          plan: resources.addPlan(effect.plan),
          lut: resources.add(lut),
          label_utf16: utf16Text(lut.label),
        };
      }
      if (effect.status === "failed")
        return { ...base, status: "failed", error_utf16: utf16Text(effect.error) };
      return { ...base, status: effect.status };
    });
    bundle.scenes.push({
      target_id: identity(scene.target.id),
      label_utf16: utf16Text(scene.label),
      scene: resources.addPlan(scene.scene),
      commands: resources.addPlan(commands),
      draw_count: scene.draws.length,
      effects,
      generators: scene.generators.map((generator) => {
        for (const shader of generator.shaders) resources.add(shader);
        return {
          instance_id: identity(generator.instanceId),
          plan: resources.addPlan(generator.plan),
          layer_name_utf16: utf16Text(generator.origin.layerName),
          plugin_id_utf16: utf16Text(generator.origin.pluginId),
        };
      }),
    });
  }
  resources.plan(bundle.graph, "precomposition_graph_slice_v1");
  for (const scene of bundle.scenes) {
    resources.plan(scene.scene, "scene_buffers_slice_v1");
    resources.plan(scene.commands, "root_scene_commands_slice_v1");
    for (const effect of scene.effects) {
      resources.plan(effect.execution, "effect_execution_slice_v1");
      if (effect.status === "ready") {
        resources.plan(effect.plan, "layer_effects_slice_v1");
        resources.resolve(effect.lut);
      }
    }
    for (const generator of scene.generators)
      resources.plan(generator.plan, "scene_generator_slice_v1");
  }
  for (const capture of pixels) {
    validateMediaPixelPayload(capture);
    requirePlan(
      resources.used.has(capture.frame.hash),
      "invalid_resource",
      "Captured media frame is unused",
    );
    const hash = resources.add(capture.pixels);
    resources.resolve(hash);
    bundle.media_pixels.push({ frame: capture.frame.hash, pixels: hash });
  }
  const counts = [
    plans.length,
    mappings.length,
    bundle.scenes.reduce((n, s) => n + s.effects.length, 0),
    bundle.scenes.reduce((n, s) => n + s.generators.length, 0),
  ];
  const bytes = new Uint8Array((4 + mappings.length) * 4),
    view = new DataView(bytes.buffer);
  [...counts, ...mappings].forEach((value, index) => {
    view.setUint32(index * 4, value, true);
  });
  const metadata = validateMetadata(
    {
      kind: "frame_plan_slice",
      plan_version: 1,
      contract_level: "precomposition_bundle_slice_v1",
      renderer_plan_complete: false,
      header: structuredClone(graph.metadata.header),
      resources: [...resources.used].sort(),
      blobs: [
        {
          byte_offset: 0,
          byte_length: bytes.length,
          element_type: "u32_le",
          element_count: bytes.length / 4,
        },
      ],
      slices: [bundle],
    },
    defaultFramePlanLimits(),
  );
  validatePlanBlob(bytes, metadata, 0);
  return {
    plan: { metadata, blobs: [bytes] },
    resources: metadata.resources.map((hash) => resources.resolve(hash)),
  };
}
