import type { PrecompositionScenePlan } from "../compositing/precomposition-scene-plan";
import { effectExecution, type PreparedLayerEffect } from "../effects/layer-effect-plan";
import { suppliedLutResource } from "../media/lut-selection-plan";
import type { GeneratorShaderResource } from "../scene/scene-generator-program";
import { canonicalJson, requirePlan } from "./canonical";
import { compositionIdentityToString as text } from "./composition-identity";
import { readEffectExecutionSlice } from "./effect-execution-plan";
import { readGeneratorSlice, validateGeneratorResources } from "./generator-plan";
import { readLayerEffectSlice } from "./layer-effect-plan";
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
    const effects = new Map<string, PreparedLayerEffect>();
    for (const effectRecord of record.effects) {
      const id = text(effectRecord.instance_id),
        execution = resources.plan(effectRecord.execution, "effect_execution_slice_v1");
      matchingFrame(execution);
      requirePlan(
        readEffectExecutionSlice(execution).instanceId === id,
        "invalid_precomposition",
        "Bundled effect identity differs",
      );
      if (effectRecord.status === "ready") {
        const plan = resources.plan(effectRecord.plan, "layer_effects_slice_v1"),
          effect = readLayerEffectSlice(plan),
          lut = resources.resolve(effectRecord.lut);
        matchingFrame(plan);
        requirePlan(
          effect.instanceId === id && effect.slice.lut_hash === effectRecord.lut,
          "invalid_precomposition",
          "Bundled effect LUT/identity differs",
        );
        requirePlan(
          lut.message.kind === "texture_pixels",
          "invalid_resource",
          "Bundled LUT has wrong kind",
        );
        const selection = {
          status: "ready" as const,
          resource: {
            message: lut.message,
            bytes: new Uint8Array(lut.bytes),
            label: readUtf16Text(effectRecord.label_utf16),
          },
        };
        suppliedLutResource(selection);
        effects.set(id, { status: "ready", plan, execution, lut: selection });
      } else if (effectRecord.status === "failed")
        effects.set(id, {
          status: "failed",
          execution,
          error: readUtf16Text(effectRecord.error_utf16),
        });
      else effects.set(id, { status: effectRecord.status, execution });
    }
    const generators = record.generators.map((record) => {
      const plan = resources.plan(record.plan, "scene_generator_slice_v1");
      matchingFrame(plan);
      const shaders = plan.metadata.resources.map((hash): GeneratorShaderResource => {
        const shader = resources.resolve(hash);
        requirePlan(
          shader.message.kind === "buffer",
          "invalid_resource",
          "Bundled shader has wrong kind",
        );
        return { message: shader.message, bytes: shader.bytes };
      });
      const decoded = readGeneratorSlice(plan, new Map(shaders.map((s) => [s.message.hash, s])));
      validateGeneratorResources(decoded);
      requirePlan(
        decoded.instanceId === text(record.instance_id),
        "invalid_precomposition",
        "Bundled generator identity differs",
      );
      return { instanceId: decoded.instanceId, plan, shaders };
    });
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
  requirePlan(
    canonicalJson([...resources.used].sort()) === canonicalJson(metadata.resources),
    "invalid_precomposition",
    "Bundle resource references are not exact",
  );
  return { graph, plans: applyPrecompositionGraph(graph, plans) };
}
