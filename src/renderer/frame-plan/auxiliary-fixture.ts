import type { GeometryBatch } from "../geometry/geometry";
import { buildAuxiliaryBatchIds } from "../gpu/auxiliary-buffer-data";
import type { AuxiliarySlice, AuxiliaryTexture } from "./auxiliary-layout";
import { buildAuxiliaryPlan } from "./auxiliary-plan";
import { encodeFramePlan } from "./codec";
import { compositionIdentityFromString } from "./composition-identity";
import { buildFrameHeader } from "./root-post-plan";

export function auxiliaryFixtures() {
  const textures: AuxiliaryTexture[] = [
    { kind: "none" },
    { kind: "media", hash: "a".repeat(64) },
    { kind: "surface", instance_id: compositionIdentityFromString("nested/surface") },
    { kind: "media", hash: "b".repeat(64) },
  ];
  const batches: GeometryBatch[] = textures.map((_, i) => ({
    instanceId: `draw/${i}`,
    resourceInstanceId: `resource/${i}`,
    selectionId: `selection/${i % 2}`,
    firstVertex: i * 3,
    vertexCount: 3,
    layer: {
      id: `layer-${i}`,
      kind: "shape",
      material: { metallic: 0, roughness: 0.25, emissive: 0 },
    } as GeometryBatch["layer"],
  }));
  const cases: {
    id: string;
    status: AuxiliarySlice["status"];
    tier: number;
    motion: boolean;
    empty?: boolean;
  }[] = [
    ...[-1, 0, 1, 2].map((tier) => ({
      id: `draw-${tier}`,
      status: "drawn" as const,
      tier,
      motion: true,
    })),
    { id: "no-motion", status: "drawn", tier: 2, motion: false },
    { id: "empty", status: "drawn", tier: 2, motion: false, empty: true },
    ...[-1, 1, 2].map((tier) => ({
      id: `clear-${tier}`,
      status: "cleared" as const,
      tier,
      motion: false,
    })),
    { id: "unavailable", status: "unavailable", tier: -1, motion: false },
  ];
  return cases.map((item) => {
    const header = buildFrameHeader({
      snapshot: { snapshotScope: "auxiliary-fixture", projectRevision: 7 },
      compositionId: "auxiliary",
      time: 1.25,
      frameRate: { numerator: 30000, denominator: 1001 },
      target: { width: 64, height: 48 },
      renderTarget: { width: 64, height: 48 },
      antiAliasing: "off",
    });
    const drawn = item.status === "drawn";
    const active = drawn && !item.empty ? batches : [];
    const motion = item.motion
      ? Float32Array.from({ length: 24 }, (_, i) => (i - 12) / 16)
      : undefined;
    const ids = buildAuxiliaryBatchIds(active);
    const input = {
      status: item.status,
      tier: item.tier,
      vertex_count: active.length * 3,
      draws: active.map((batch, i) => ({
        instance_id: compositionIdentityFromString(batch.instanceId),
        first_vertex: batch.firstVertex,
        vertex_count: batch.vertexCount,
        texture: textures[i],
      })),
      generators:
        drawn && !item.empty
          ? [
              compositionIdentityFromString("particles/second"),
              compositionIdentityFromString("particles/first"),
            ]
          : [],
    };
    const plan = buildAuxiliaryPlan(header, input, ids, motion);
    return {
      id: `auxiliary-${item.id}`,
      auxiliary: { ...item, batches: active, textures, ids, motion },
      plan,
      bytes: encodeFramePlan(plan.metadata, plan.blobs),
    };
  });
}
