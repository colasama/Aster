import { DEFAULT_MOTION_BLUR_SETTINGS } from "../../core/animation/motion-blur";
import type { RootSceneCommand } from "../compositing/root-scene-commands";
import { effectExecution } from "../effects/layer-effect-plan";
import { encodeFramePlan } from "./codec";
import { buildFinalOutputPlan } from "./final-output-plan";
import { buildFrameBundle } from "./frame-bundle-plan";
import { generatorFixtures } from "./generator-fixture";
import { layerEffectFixtures } from "./layer-effect-fixture";
import { buildMotionReconstructionPlan } from "./motion-reconstruction-plan";
import { precompositionBundleFixtures } from "./precomposition-bundle-fixture";
import { buildRootPostUniformPlan } from "./root-post-plan";
import { buildRootScenePlan } from "./root-scene-plan";
import { sceneBufferFixtureInput } from "./scene-buffer-fixture";
import { buildSceneBufferPlan } from "./scene-buffer-plan";
import { prepareSceneBuffers } from "./scene-buffer-upload";

export function frameBundleFixtures() {
  return [false, true].map((empty) => {
    const input = {
        ...sceneBufferFixtureInput(empty),
        target: { width: 64, height: 48 },
        renderTarget: { width: 64, height: 48 },
      },
      scene = buildSceneBufferPlan(input),
      header = scene.metadata.header;
    const effects = empty
      ? []
      : layerEffectFixtures().map((f) => {
          f.prepared.plan.metadata.header = structuredClone(header);
          f.prepared.execution.metadata.header = structuredClone(header);
          return [f.effect.instanceId, f.prepared] as const;
        });
    const generators = empty ? [] : generatorFixtures().map((f) => f.generator);
    const draws = prepareSceneBuffers(scene).draws.map((d) => ({
      ...d,
      blendMode: "normal" as const,
      texture: { kind: "none" as const },
    }));
    const commands: RootSceneCommand[] = [
      {
        kind: "begin_scene",
        group: "composition",
        color: { loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] },
        depth: { loadOp: "clear", storeOp: "store", clearValue: 1 },
      },
      ...draws.map((_, drawIndex) => ({
        kind: "geometry" as const,
        drawIndex,
        blendMode: "normal" as const,
      })),
      ...generators.map((g) => ({
        kind: "generator" as const,
        instanceId: g.instanceId,
        blendMode: g.blendMode,
      })),
      { kind: "end_scene" },
    ];
    const adjustment = effects.find(([, effect]) => effectExecution(effect).route === "adjustment");
    if (adjustment) commands.push({ kind: "adjustment", effect: effectExecution(adjustment[1]) });
    const output = {
      auxiliary: null,
      effect: null,
      output: buildFinalOutputPlan(header, {
        visualization: "beauty",
        auxiliaryValid: false,
        beautyDepthOfField: false,
        motionBlurValid: false,
        motionBlurBindingAvailable: false,
      }),
      motion: buildMotionReconstructionPlan(header, {
        requested: false,
        resourcesAvailable: false,
        settings: DEFAULT_MOTION_BLUR_SETTINGS,
        shutter: { openTime: 1, duration: 0 },
        compositionWidth: header.target.width,
      }),
    };
    const frameBundle = buildFrameBundle({
      scene,
      root: buildRootScenePlan(header, commands, draws),
      post: buildRootPostUniformPlan(input),
      output,
      shadowMapSize: 1024,
      effects: new Map(effects),
      generators: generators.map((plan) => ({ plan, capacity: plan.capacity })),
      resources: [],
      precompositions: empty ? undefined : precompositionBundleFixtures()[0].bundle,
    });
    return {
      id: empty ? "frame-bundle-empty" : "frame-bundle-programs-recursive",
      frameBundle,
      bytes: encodeFramePlan(frameBundle.plan.metadata, frameBundle.plan.blobs),
    };
  });
}
