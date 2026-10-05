import { createLayerForComposition } from "../../../src/core/layers/layer-factory";
import { createBlankComposition } from "../../../src/core/project/project";
import { flattenSceneLayers } from "../../../src/core/scene/scene-evaluation";
import type { AuxiliaryTexture } from "../../../src/renderer/frame-plan/auxiliary-layout";
import { compositionIdentityFromString } from "../../../src/renderer/frame-plan/composition-identity";
import { contentResourceHashSync } from "../../../src/renderer/frame-plan/resources";
import { buildSceneBufferPlan } from "../../../src/renderer/frame-plan/scene-buffer-plan";
import type { PutResource } from "../../../src/renderer/frame-plan/types";
import { buildSceneGeometry } from "../../../src/renderer/geometry/geometry";
import { buildSceneLighting } from "../../../src/renderer/scene/scene-lighting";

export function auxiliaryGpuFixture(id: string) {
  const tier = id === "basic" ? -1 : id === "tier0" ? 0 : id === "tier1" ? 1 : 2;
  const composition = createBlankComposition();
  composition.id = "auxiliary-gpu";
  composition.width = 64;
  composition.height = 48;
  composition.layers = Array.from({ length: 4 }, (_, i) => {
    const layer = createLayerForComposition("shape", composition);
    layer.id = `shape-${i}`;
    layer.size = [34, 30];
    layer.color = [0.2 + i * 0.15, 0.7 - i * 0.12, 0.3 + i * 0.1, 0.75];
    layer.transform.position = [
      { mode: "static", value: 22 + i * 6 },
      { mode: "static", value: 20 + i * 3 },
      { mode: "static", value: 0 },
    ];
    layer.transform.anchor = [
      { mode: "static", value: 17 },
      { mode: "static", value: 15 },
      { mode: "static", value: 0 },
    ];
    return layer;
  });
  const scene = flattenSceneLayers(composition, undefined, 0);
  const geometry = buildSceneGeometry(composition, scene);
  for (const [i, batch] of geometry.batches.entries())
    for (let v = batch.firstVertex; v < batch.firstVertex + batch.vertexCount; v++)
      geometry.data[v * 40 + 2] = 0.15 + i * 0.2;
  const vertexCount = geometry.data.length / 40;
  const motion =
    id === "no-motion"
      ? undefined
      : Float32Array.from({ length: vertexCount * 2 }, (_, i) => (i % 2 ? 0.0625 : -0.125));
  const plan = buildSceneBufferPlan({
    snapshot: { snapshotScope: "auxiliary-gpu", projectRevision: 1 },
    compositionId: composition.id,
    time: 0,
    frameRate: composition.frameRate,
    target: { width: 64, height: 48 },
    renderTarget: { width: 64, height: 48 },
    antiAliasing: "off",
    geometry,
    lighting: buildSceneLighting(scene, composition, false),
    motionVectors: motion,
    shadowsEnabled: false,
  });
  const resources = geometry.batches.slice(1).map((batch, index) => {
    const pixels = Uint8Array.from({ length: 4 * 4 * 4 }, (_, i) =>
      i % 4 === 3
        ? (Math.floor(i / 4) + index) % 3 === 0
          ? 0
          : 180
        : 40 + index * 50 + (i % 4) * 30,
    );
    const content = {
      kind: "texture_pixels" as const,
      descriptor: {
        dimension: "2d" as const,
        width: 4,
        height: 4,
        depth: 1,
        format: "rgba8unorm" as const,
      },
    };
    const message: PutResource = {
      type: "put_resource",
      ...content,
      hash: contentResourceHashSync(content, pixels),
    };
    const texture: AuxiliaryTexture =
      index !== 1
        ? { kind: "media", hash: message.hash }
        : {
            kind: "surface",
            instance_id: compositionIdentityFromString(batch.instanceId),
          };
    return { instanceId: batch.instanceId, texture, message, pixels };
  });
  return { tier, geometry, plan, motion, vertexCount, resources };
}
