import {
  createGeneratorLayerForComposition,
  createLayerForComposition,
} from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { flattenSceneLayers } from "../../core/scene/scene-evaluation";
import { createSceneGeneratorInstance } from "../../core/scene/scene-generator-registry";
import { createEffect } from "../../effects/registry";
import { bindPrecompositionSceneMedia } from "../compositing/precomposition-scene-media";
import { buildPrecompositionScenePlan } from "../compositing/precomposition-scene-plan";
import { prepareLayerEffects } from "../effects/layer-effect-plan";
import { buildSceneGeometry } from "../geometry/geometry";
import { LutSelectionPlanner } from "../media/lut-selection-plan";
import { bundledParticleDefinition } from "../scene/bundled-particle-generator";
import { SceneGeneratorPlanner } from "../scene/scene-generator-plan";
import { buildSceneLighting } from "../scene/scene-lighting";
import { encodeFramePlan } from "./codec";
import { buildPrecompositionGraph, readPrecompositionGraph } from "./precomposition-graph-plan";
import { buildFrameHeader } from "./root-post-plan";

export function precompositionGraphFixtures(rich = false, mediaHash: string | null = null) {
  const project = createBlankProject(),
    parent = project.compositions[0];
  parent.width = 64;
  parent.height = 48;
  const leaf = structuredClone(parent);
  leaf.id = "child";
  leaf.layers = [createLayerForComposition("shape", leaf)];
  if (rich) {
    leaf.layers[0].effects = [createEffect("exposure")];
    leaf.layers.push(createLayerForComposition("image", leaf));
    leaf.layers.push(
      createGeneratorLayerForComposition(
        leaf,
        createSceneGeneratorInstance(bundledParticleDefinition),
      ),
    );
  }
  project.compositions.push(leaf);
  parent.layers = Array.from({ length: 3 }, () => {
    const layer = createLayerForComposition("precomposition", parent);
    layer.sourceCompositionId = leaf.id;
    layer.threeDimensional = true;
    return layer;
  });
  parent.layers.push(createLayerForComposition("shape", parent));
  const ids = ["child\ud800", "parent\0cache"];
  const plans = [leaf, parent].map((composition, index) => {
    const layers = flattenSceneLayers(composition, project, 1.25);
    const header = buildFrameHeader({
      snapshot: { snapshotScope: "graph-fixture", projectRevision: 7 },
      compositionId: composition.id,
      time: 1.25,
      frameRate: composition.frameRate,
      target: { width: 64, height: 48 },
      renderTarget: { width: 64, height: 48 },
      antiAliasing: "off",
    });
    const planner = new SceneGeneratorPlanner();
    const generators = layers
      .filter((s) => s.layer.kind === "generator")
      .map((scene) =>
        planner.prepare({
          scene,
          composition,
          definition: bundledParticleDefinition,
          width: 64,
          height: 48,
          storageByteLimit: 16777216,
          dispatchWorkgroupLimit: 65535,
        }),
      );
    const hasEffects = rich && index === 0;
    const wrappers = layers.filter((s) => s.precompositionSurface);
    const surfaceTargets = new Map(wrappers.slice(0, 2).map((s) => [s.instanceId, ids[0]]));
    return bindPrecompositionSceneMedia(
      buildPrecompositionScenePlan({
        target: {
          id: ids[index],
          width: 64,
          height: 48,
          estimatedBytes: 64 * 48 * (hasEffects ? 38 : 12),
          textureCount: hasEffects ? 5 : 2,
          hasEffects,
        },
        revision: 7,
        composition,
        time: 1.25,
        layers,
        geometry: buildSceneGeometry(composition, layers),
        lighting: buildSceneLighting(layers, composition, false),
        effects: prepareLayerEffects({
          scene: layers,
          composition,
          header,
          context: "precomposition",
          mipLevelCount: 1,
          planner: new LutSelectionPlanner(),
        }),
        generators,
        surfaceTargets,
      }),
      {
        hashFor: () => mediaHash,
        bindingForHash: () => (mediaHash ? ({} as GPUBindGroup) : undefined),
      },
    );
  });
  const bindings = new Map([
    ["root/a", ids[1]],
    ["root/b", ids[1]],
    ["nested/leaf", ids[0]],
  ]);
  const nodes = plans.map((p) => ({
    target: p.target,
    drawTargets: p.draws.map((d) =>
      d.texture.kind === "surface" ? d.texture.targetId : undefined,
    ),
  }));
  return [
    { id: "precomposition-nested-shared-skipped", plans, nodes, bindings },
    { id: "precomposition-empty", plans: [], nodes: [], bindings: new Map<string, string>() },
  ].map((fixture) => {
    const plan = buildPrecompositionGraph(
      plans[0].scene.metadata.header,
      fixture.nodes,
      fixture.bindings,
    );
    return {
      ...fixture,
      ...plan,
      graph: readPrecompositionGraph(plan),
      bytes: encodeFramePlan(plan.metadata, plan.blobs),
    };
  });
}
