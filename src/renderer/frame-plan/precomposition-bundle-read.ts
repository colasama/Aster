import type { PrecompositionScenePlan } from "../compositing/precomposition-scene-plan";
import { effectExecution } from "../effects/layer-effect-plan";
import { validateMediaPixelPayload } from "../media/media-pixel-payload";
import { readBundlePrograms } from "./bundle-programs-read";
import { canonicalJson, requirePlan } from "./canonical";
import { compositionIdentityToString as text } from "./composition-identity";
import { readUtf16Text } from "./precomposition-bundle-layout";
import {
  type BundleResource,
  PrecompositionBundleResources,
} from "./precomposition-bundle-resources";
import { applyPrecompositionGraph, readPrecompositionGraph } from "./precomposition-graph-plan";
import { readRootScenePlan } from "./root-scene-plan";
import { prepareSceneBuffers } from "./scene-buffer-upload";
import { defaultFramePlanLimits, type FramePlanSliceData } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

export function readPrecompositionBundle(
  input: FramePlanSliceData,
  packets: readonly BundleResource[],
) {
  const metadata = validateMetadata(input.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.contract_level === "precomposition_bundle_slice_v1" && input.blobs.length === 1,
    "invalid_precomposition",
    "Expected one surface bundle",
  );
  const bundle = metadata.slices[0];
  requirePlan(
    bundle.kind === "precomposition_bundle",
    "invalid_precomposition",
    "Missing surface bundle",
  );
  validatePlanBlob(input.blobs[0], metadata, 0);
  const resources = new PrecompositionBundleResources();
  for (const packet of packets) resources.add(packet);
  for (const hash of metadata.resources)
    requirePlan(
      resources.entries.has(hash),
      "missing_resource",
      "Missing declared bundle dependency",
    );
  const graphPlan = resources.plan(bundle.graph, "precomposition_graph_slice_v1"),
    graph = readPrecompositionGraph(graphPlan);
  requirePlan(
    canonicalJson(graphPlan.metadata.header) === canonicalJson(metadata.header) &&
      graph.nodes.length === bundle.scenes.length,
    "invalid_precomposition",
    "Surface graph bundle header/count mismatch",
  );
  const view = new DataView(
    input.blobs[0].buffer,
    input.blobs[0].byteOffset,
    input.blobs[0].byteLength,
  );
  let offset = 16;
  const plans = bundle.scenes.map((record): PrecompositionScenePlan => {
    const id = text(record.target_id),
      node = graph.nodes.find((node) => node.target.id === id);
    requirePlan(node, "missing_resource", "Bundled scene target is absent");
    const scene = resources.plan(record.scene, "scene_buffers_slice_v1"),
      buffers = prepareSceneBuffers(scene);
    const matchingFrame = (plan: FramePlanSliceData) => {
      requirePlan(
        canonicalJson({ ...plan.metadata.header, snapshot_scope: "" }) ===
          canonicalJson({ ...scene.metadata.header, snapshot_scope: "" }),
        "invalid_precomposition",
        "Bundled dependency frame differs",
      );
    };
    const rootPlan = resources.plan(record.commands, "root_scene_commands_slice_v1"),
      root = readRootScenePlan(rootPlan);
    const sceneSlice = scene.metadata.slices[0];
    requirePlan(
      sceneSlice.kind === "scene_buffers",
      "invalid_precomposition",
      "Missing bundled geometry",
    );
    const media = new Map(sceneSlice.media_bindings.map((m) => [m.draw_index, m.binding]));
    requirePlan(
      canonicalJson(rootPlan.metadata.header) === canonicalJson(scene.metadata.header) &&
        root.draws.length === record.draw_count &&
        node.drawTargets.length === record.draw_count,
      "invalid_precomposition",
      "Bundled command scene mismatch",
    );
    const draws = root.draws.map((draw, index) => {
      const sceneDrawIndex = view.getUint32(offset, true);
      offset += 4;
      const geometry = buffers.draws[sceneDrawIndex],
        targetId = node.drawTargets[index];
      requirePlan(
        geometry &&
          geometry.instanceId === draw.instanceId &&
          geometry.firstVertex === draw.firstVertex &&
          geometry.vertexCount === draw.vertexCount &&
          !draw.material,
        "invalid_precomposition",
        "Bundled draw differs from geometry",
      );
      if (targetId !== undefined) {
        requirePlan(
          targetId === null
            ? draw.texture.kind === "none"
            : draw.texture.kind === "surface" && draw.texture.instanceId === targetId,
          "invalid_precomposition",
          "Bundled draw differs from graph route",
        );
        return {
          sceneDrawIndex,
          firstVertex: draw.firstVertex,
          vertexCount: draw.vertexCount,
          texture: { kind: "surface" as const, targetId },
        };
      }
      requirePlan(
        draw.texture.kind === "none" || draw.texture.kind === "media",
        "invalid_precomposition",
        "Unexpected bundled texture reference",
      );
      if (draw.texture.kind === "media") {
        const binding = media.get(sceneDrawIndex);
        requirePlan(
          binding &&
            (binding.kind === "pending"
              ? draw.texture.hash === null
              : draw.texture.hash === binding.hash),
          "invalid_precomposition",
          "Bundled media differs from scene binding",
        );
        if (draw.texture.hash !== null)
          requirePlan(
            resources.resolve(draw.texture.hash).message.kind === "media_frame",
            "invalid_resource",
            "Bundled media requires a frame descriptor",
          );
        media.delete(sceneDrawIndex);
      }
      return {
        sceneDrawIndex,
        firstVertex: draw.firstVertex,
        vertexCount: draw.vertexCount,
        texture: draw.texture,
      };
    });
    requirePlan(media.size === 0, "invalid_precomposition", "Unmatched bundled media binding");
    const { effects, generators } = readBundlePrograms(
      record.effects,
      record.generators,
      resources,
      matchingFrame,
    );
    for (const command of root.commands) {
      if (command.kind === "begin_layer" || command.kind === "adjustment")
        requirePlan(
          canonicalJson(effectExecution(effects.get(command.effect.instanceId))) ===
            canonicalJson(command.effect),
          "invalid_precomposition",
          "Bundled effect routing differs",
        );
      if (command.kind === "generator")
        requirePlan(
          generators.some((g) => g.instanceId === command.instanceId),
          "missing_resource",
          "Bundled generator draw has no invocation",
        );
    }
    return {
      target: node.target,
      label: readUtf16Text(record.label_utf16),
      scene,
      commands: root.commands,
      draws,
      effects,
      generators,
    };
  });
  const mediaPixels = bundle.media_pixels.map((record) => {
    requirePlan(
      resources.used.has(record.frame),
      "invalid_resource",
      "Captured media frame is unused",
    );
    const frame = resources.resolve(record.frame).message;
    const pixels = resources.resolve(record.pixels);
    const capture = { frame, pixels };
    validateMediaPixelPayload(capture);
    return capture;
  });
  requirePlan(
    canonicalJson([...resources.used].sort()) === canonicalJson(metadata.resources),
    "invalid_precomposition",
    "Bundle resource references are not exact",
  );
  return { graph, plans: applyPrecompositionGraph(graph, plans), mediaPixels };
}
