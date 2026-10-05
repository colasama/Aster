import { createLayerForComposition } from "../../../src/core/layers/layer-factory";
import { createBlankProject } from "../../../src/core/project/project";
import { flattenSceneLayers } from "../../../src/core/scene/scene-evaluation";
import { createEffect } from "../../../src/effects/registry";
import { planRootSceneStack } from "../../../src/renderer/compositing/render-stack";
import { planRootSceneCommands } from "../../../src/renderer/compositing/root-scene-commands";
import { effectExecution } from "../../../src/renderer/effects/layer-effect-plan";
import type { LayerEffectRenderer } from "../../../src/renderer/effects/layer-effects";
import { buildRootScenePlan } from "../../../src/renderer/frame-plan/root-scene-plan";
import { buildSceneBufferPlan } from "../../../src/renderer/frame-plan/scene-buffer-plan";
import { buildSceneGeometry } from "../../../src/renderer/geometry/geometry";
import { buildSceneLighting } from "../../../src/renderer/scene/scene-lighting";

export function rootFixture(id: string, producer: LayerEffectRenderer) {
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.id = `root-${id}`;
  composition.width = 64;
  composition.height = 48;
  composition.background = [0.04, 0.08, 0.12, 0.25];
  const layers = Array.from({ length: 3 }, (_, i) => {
    const layer = createLayerForComposition("shape", composition);
    layer.id = `shape-${i}`;
    layer.size = [32, 30];
    layer.color = [
      [0.85, 0.1, 0.15, 0.7],
      [0.1, 0.8, 0.2, 0.65],
      [0.15, 0.25, 0.9, 0.8],
    ][i] as [number, number, number, number];
    layer.transform.anchor = [
      { mode: "static", value: 16 },
      { mode: "static", value: 15 },
      { mode: "static", value: 0 },
    ];
    layer.transform.position = [
      { mode: "static", value: 24 + i * 8 },
      { mode: "static", value: 20 + i * 3 },
      { mode: "static", value: 0 },
    ];
    layer.threeDimensional = id === "depth" && i < 2;
    return layer;
  });
  if (id === "isolated") {
    layers[1].blendMode = "multiply";
    layers[1].effects = [createEffect("gaussian-blur")];
  }
  composition.layers = [...layers].reverse();
  if (id === "adjustment") {
    const adjustment = createLayerForComposition("adjustment", composition);
    adjustment.id = "adjustment";
    adjustment.effects = [createEffect("invert")];
    composition.layers.splice(1, 0, adjustment);
  }
  const scene = flattenSceneLayers(composition, project, 0);
  const geometry = buildSceneGeometry(composition, scene);
  // Explicit clip depths make preserving versus clearing depth observably different.
  // The root stack still derives its 3D-to-2D transition from authored layer flags.
  if (id === "depth")
    for (const batch of geometry.batches) {
      const z = batch.layer.id === "shape-0" ? 0.2 : batch.layer.id === "shape-1" ? 0.6 : 0.8;
      for (let v = batch.firstVertex; v < batch.firstVertex + batch.vertexCount; v++)
        geometry.data[v * 40 + 2] = z;
    }
  const lighting = buildSceneLighting(scene, composition, false);
  const scenePlan = buildSceneBufferPlan({
    snapshot: { snapshotScope: "root-replay", projectRevision: 1 },
    compositionId: composition.id,
    time: 0,
    frameRate: composition.frameRate,
    target: { width: 64, height: 48 },
    renderTarget: { width: 64, height: 48 },
    antiAliasing: "off",
    geometry,
    lighting,
    shadowsEnabled: false,
  });
  const effects = new Map(
    scene.map((item) => [
      item.instanceId,
      producer.prepareEffect(
        composition,
        item.layer,
        item.instanceId,
        item.localTime,
        scenePlan.metadata.header,
        undefined,
        "root",
      ),
    ]),
  );
  for (const effect of effects.values()) if (effect.status === "failed") throw Error(effect.error);
  const stack = planRootSceneStack(scene, geometry.batches);
  const commands = planRootSceneCommands(
    stack,
    new Map(Array.from(effects, ([id, e]) => [id, effectExecution(e)])),
    new Set(),
    composition.background,
  );
  const rootPlan = buildRootScenePlan(scenePlan.metadata.header, commands, stack.draws);
  return {
    composition,
    stack,
    effects,
    scenePlan,
    rootPlan,
    buffers: {
      lighting: new Uint8Array(lighting.buffer, lighting.byteOffset, lighting.byteLength),
      vertices: new Uint8Array(
        geometry.data.buffer,
        geometry.data.byteOffset,
        geometry.data.byteLength,
      ),
    },
  };
}
