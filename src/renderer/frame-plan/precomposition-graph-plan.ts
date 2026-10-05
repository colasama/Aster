import type {
  PrecompositionScenePlan,
  PrecompositionTarget,
} from "../compositing/precomposition-scene-plan";
import { requirePlan } from "./canonical";
import {
  compositionIdentityFromString as identity,
  compositionIdentityToString as text,
} from "./composition-identity";
import type { PrecompositionGraphSlice } from "./precomposition-graph-layout";
import { defaultFramePlanLimits, type FrameHeaderSlice, type FramePlanSliceData } from "./types";
import { validateMetadata, validatePlanBlob } from "./validation";

export interface PrecompositionGraphNode {
  target: PrecompositionTarget;
  /** Undefined is a non-surface draw; null is an explicitly budget-skipped surface. */
  drawTargets: (string | null | undefined)[];
}
export function buildPrecompositionGraph(
  header: FrameHeaderSlice,
  nodes: readonly PrecompositionGraphNode[],
  bindings: ReadonlyMap<string, string>,
): FramePlanSliceData {
  const indices = new Map(nodes.map((node, index) => [node.target.id, index]));
  const lookup = (id: string) => {
    const index = indices.get(id);
    requirePlan(index !== undefined, "missing_resource", "Surface target is absent from graph");
    return index;
  };
  const graph: PrecompositionGraphSlice = {
    kind: "precomposition_graph",
    blob_index: 0,
    targets: nodes.map(({ target: t, drawTargets }) => ({
      id: identity(t.id),
      width: t.width,
      height: t.height,
      estimated_bytes: t.estimatedBytes,
      texture_count: t.textureCount,
      has_effects: t.hasEffects,
      draw_count: drawTargets.length,
    })),
    bindings: [...bindings].map(([id, target]) => ({
      instance_id: identity(id),
      target_index: lookup(target),
    })),
  };
  const count = nodes.reduce((n, node) => n + node.drawTargets.length, 0);
  const bytes = new Uint8Array(16 + count * 4),
    view = new DataView(bytes.buffer);
  [nodes.length, count, bindings.size, 0].forEach((v, i) => {
    view.setUint32(i * 4, v, true);
  });
  let offset = 16;
  for (const node of nodes)
    for (const target of node.drawTargets) {
      view.setUint32(
        offset,
        target === undefined ? 0 : target === null ? 1 : lookup(target) + 2,
        true,
      );
      offset += 4;
    }
  const metadata = validateMetadata(
    {
      kind: "frame_plan_slice",
      plan_version: 1,
      contract_level: "precomposition_graph_slice_v1",
      renderer_plan_complete: false,
      header: structuredClone(header),
      resources: [],
      blobs: [
        {
          byte_offset: 0,
          byte_length: bytes.length,
          element_type: "u32_le",
          element_count: bytes.length / 4,
        },
      ],
      slices: [graph],
    },
    defaultFramePlanLimits(),
  );
  validatePlanBlob(bytes, metadata, 0);
  return { metadata, blobs: [bytes] };
}

export function readPrecompositionGraph(plan: FramePlanSliceData): {
  nodes: PrecompositionGraphNode[];
  bindings: Map<string, string>;
} {
  const metadata = validateMetadata(plan.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.contract_level === "precomposition_graph_slice_v1" && plan.blobs.length === 1,
    "invalid_precomposition",
    "Expected one surface graph",
  );
  const graph = metadata.slices[0];
  requirePlan(
    graph.kind === "precomposition_graph",
    "invalid_precomposition",
    "Missing surface graph",
  );
  validatePlanBlob(plan.blobs[0], metadata, 0);
  const view = new DataView(
    plan.blobs[0].buffer,
    plan.blobs[0].byteOffset,
    plan.blobs[0].byteLength,
  );
  let offset = 16;
  const nodes = graph.targets.map((t) => ({
    target: {
      id: text(t.id),
      width: t.width,
      height: t.height,
      estimatedBytes: t.estimated_bytes,
      textureCount: t.texture_count,
      hasEffects: t.has_effects,
    },
    drawTargets: Array.from({ length: t.draw_count }, () => {
      const route = view.getUint32(offset, true);
      offset += 4;
      return route === 0 ? undefined : route === 1 ? null : text(graph.targets[route - 2].id);
    }),
  }));
  return {
    nodes,
    bindings: new Map(
      graph.bindings.map((b) => [text(b.instance_id), text(graph.targets[b.target_index].id)]),
    ),
  };
}

/** Execute graph order and routing against separately supplied scene payloads. */
export function applyPrecompositionGraph(
  graph: ReturnType<typeof readPrecompositionGraph>,
  plans: readonly PrecompositionScenePlan[],
): PrecompositionScenePlan[] {
  const byId = new Map(plans.map((p) => [p.target.id, p]));
  requirePlan(
    byId.size === plans.length && graph.nodes.length === plans.length,
    "invalid_precomposition",
    "Surface graph and scene count differ",
  );
  return graph.nodes.map(({ target, drawTargets }) => {
    const scene = byId.get(target.id);
    requirePlan(scene, "missing_resource", "Surface graph scene payload is absent");
    requirePlan(
      scene.scene.metadata.header.render_target.width === target.width &&
        scene.scene.metadata.header.render_target.height === target.height &&
        scene.draws.length === drawTargets.length,
      "invalid_precomposition",
      "Surface graph scene layout differs",
    );
    return {
      ...scene,
      target: { ...target },
      draws: scene.draws.map((draw, index) => {
        const targetId = drawTargets[index];
        requirePlan(
          (draw.texture.kind === "surface") === (targetId !== undefined),
          "invalid_precomposition",
          "Surface routing draw kind differs",
        );
        return targetId === undefined ? draw : { ...draw, texture: { kind: "surface", targetId } };
      }),
    };
  });
}
