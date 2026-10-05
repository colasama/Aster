import { buildDepthEffectUniforms, DEFAULT_DEPTH_EFFECT_SETTINGS } from "../effects/depth-effects";
import { buildSurfacePostUniforms } from "../effects/surface-post-effects";
import { encodeFramePlan } from "./codec";
import type { DepthInputs, PostEffect } from "./post-effect-layout";
import { buildPostEffectPlan } from "./post-effect-plan";
import { buildFrameHeader } from "./root-post-plan";

export function postEffectFixtures() {
  const full: DepthInputs = [
    "scene",
    "worldPosition",
    "transparentWorldPosition",
    "peeledWorldPosition",
    "frontLayerColor",
    "peeledLayerColor",
  ];
  const fallback: DepthInputs = [
    "scene",
    "worldPosition",
    "worldPosition",
    "worldPosition",
    "scene",
    "scene",
  ];
  const motion: DepthInputs = [
    "motion_blur",
    "worldPosition",
    "worldPosition",
    "worldPosition",
    "motion_blur",
    "motion_blur",
  ];
  const cases: { id: string; ready: boolean; effect: PostEffect }[] = [
    { id: "fog", ready: true, effect: { kind: "depth", mode: "depthFog", inputs: full } },
    { id: "lens", ready: true, effect: { kind: "depth", mode: "depthOfField", inputs: full } },
    {
      id: "fallback",
      ready: true,
      effect: { kind: "depth", mode: "depthOfField", inputs: fallback },
    },
    {
      id: "motion-source",
      ready: true,
      effect: { kind: "depth", mode: "depthOfField", inputs: motion },
    },
    {
      id: "depth-skipped",
      ready: false,
      effect: { kind: "depth", mode: "depthOfField", inputs: fallback },
    },
    {
      id: "selection",
      ready: true,
      effect: {
        kind: "surface",
        mode: "selectionIsolation",
        inputs: ["scene", "objectId", "motionVector"],
      },
    },
    {
      id: "vectors",
      ready: true,
      effect: {
        kind: "surface",
        mode: "vectorMotionBlur",
        inputs: ["scene", "objectId", "motionVector"],
      },
    },
    {
      id: "surface-skipped",
      ready: false,
      effect: {
        kind: "surface",
        mode: "selectionIsolation",
        inputs: ["scene", "objectId", "motionVector"],
      },
    },
  ];
  return cases.map((item) => {
    const header = buildFrameHeader({
      snapshot: { snapshotScope: "post-fixture", projectRevision: 7 },
      compositionId: "post",
      time: 1.25,
      frameRate: { numerator: 30000, denominator: 1001 },
      target: { width: 64, height: 48 },
      renderTarget: { width: 64, height: 48 },
      antiAliasing: "off",
    });
    const settings = {
      ...DEFAULT_DEPTH_EFFECT_SETTINGS,
      cameraPosition: [-3, 4, 5] as const,
      focusDistance: 12.5,
      irisRotation: -270,
      highlightGain: 75,
    };
    let uniforms: Uint8Array;
    if (item.effect.kind === "depth") {
      const floats = buildDepthEffectUniforms(item.effect.mode, 64, 48, settings);
      uniforms = new Uint8Array(floats.byteLength);
      const view = new DataView(uniforms.buffer);
      floats.forEach((v, i) => {
        view.setFloat32(i * 4, v, true);
      });
    } else
      uniforms = new Uint8Array(
        buildSurfacePostUniforms(item.effect.mode, 64, 48, 0xfeed1234, 1.5),
      );
    const plan = buildPostEffectPlan(header, item.effect, item.ready, uniforms);
    return {
      id: `post-${item.id}`,
      postEffect: { ...item, settings, uniforms: new Uint8Array(uniforms) },
      plan,
      bytes: encodeFramePlan(plan.metadata, plan.blobs),
    };
  });
}
