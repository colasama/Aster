import { describe, expect, it, vi } from "vitest";
import { motionBlurInterval } from "../../core/animation/motion-blur";
import type { TextAnimatorProperties } from "../../core/animation/text-animator-stack";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { flattenSceneLayers } from "../../core/scene/scene-evaluation";
import { type Animatable, staticValue } from "../../core/types";
import { buildSceneGeometry } from "../geometry/geometry";
import { buildTimeAddressedMotionVectors } from "../scene/time-addressed-motion-vectors";
import {
  estimateTextAnimatorPixelTravel,
  planTextMotionBlurFrame,
  TEXT_MOTION_BLUR_TIME_BUCKETS_PER_SECOND,
  textMotionBlurTimeBucket,
} from "./text-motion-blur-plan";

describe("text animator motion-blur planning", () => {
  it("keeps exact sub-frame character animation samples when the layer transform is static", () => {
    const { project, composition, text } = fixture();
    const frameTime = 1;
    const plan = planTextMotionBlurFrame({
      composition,
      project,
      frameTime,
      sceneLayers: flattenSceneLayers(composition, project, frameTime),
    });
    const textPlan = plan.plans.get(`root/${text.id}`);

    expect(plan.sampleCount).toBeGreaterThanOrEqual(composition.motionBlur.samplesPerFrame);
    expect(textPlan?.samples.length).toBeGreaterThan(1);
    expect(new Set(textPlan?.samples.map((sample) => sample.timeBucket)).size).toBe(
      textPlan?.samples.length,
    );
    expect(textPlan?.samples[0]?.localTime).not.toBe(
      textPlan?.samples[textPlan.samples.length - 1]?.localTime,
    );
    expect(text.transform.position.every((track) => track.mode === "static")).toBe(true);
    expect(layerMotionVectors(composition, project, text.id).every((value) => value === 0)).toBe(
      true,
    );
  });

  it("does no extra texture sampling when either motion-blur switch is disabled", () => {
    const { project, composition, text } = fixture();
    const sceneLayers = flattenSceneLayers(composition, project, 1);

    composition.motionBlur.enabled = false;
    expect(
      planTextMotionBlurFrame({ composition, project, frameTime: 1, sceneLayers }).plans.size,
    ).toBe(0);
    composition.motionBlur.enabled = true;
    text.motionBlur = false;
    expect(
      planTextMotionBlurFrame({ composition, project, frameTime: 1, sceneLayers }).plans.size,
    ).toBe(0);
  });

  it.each([
    ["enters", 1.001, 2],
    ["exits", 0, 0.999],
  ])(
    "keeps partial exposure when a text layer %s inside the shutter",
    (_label, inPoint, outPoint) => {
      const { project, composition, text } = fixture();
      text.inPoint = inPoint;
      text.outPoint = outPoint;
      const sceneLayers = flattenSceneLayers(composition, project, 1);
      expect(sceneLayers).toHaveLength(0);

      const plan = planTextMotionBlurFrame({
        composition,
        project,
        frameTime: 1,
        sceneLayers,
      });
      const textPlan = plan.plans.get(`root/${text.id}`);

      expect(textPlan?.transparentWeight).toBeGreaterThan(0);
      expect(textPlan?.transparentWeight).toBeLessThan(1);
      expect(textPlan?.samples.length).toBeGreaterThan(0);
      expect(plan.exposureSceneLayers.map((scene) => scene.resourceInstanceId)).toEqual([
        `root/${text.id}`,
      ]);
    },
  );

  it("leaves moving layers with static glyph pixels on the geometry-vector-only path", () => {
    const { project, composition, text } = fixture();
    const position = text.textAnimator?.groups[0]?.properties.position;
    if (!position) throw new Error("Expected text position animator");
    position[0] = staticValue(25);
    text.transform.position[0] = {
      mode: "animated",
      keyframes: [
        { id: "layer-open", time: 0, value: 400, interpolation: "linear" },
        { id: "layer-close", time: 2, value: 800, interpolation: "linear" },
      ],
    };

    const plan = planTextMotionBlurFrame({
      composition,
      project,
      frameTime: 1,
      sceneLayers: flattenSceneLayers(composition, project, 1),
    });
    expect(plan.plans.size).toBe(0);
    expect(layerMotionVectors(composition, project, text.id).some((value) => value !== 0)).toBe(
      true,
    );
  });

  it("combines text temporal samples with an independently moving layer", () => {
    const { project, composition, text } = fixture();
    text.transform.position[0] = {
      mode: "animated",
      keyframes: [
        { id: "layer-open", time: 0, value: 400, interpolation: "linear" },
        { id: "layer-close", time: 2, value: 800, interpolation: "linear" },
      ],
    };
    const plan = planTextMotionBlurFrame({
      composition,
      project,
      frameTime: 1,
      sceneLayers: flattenSceneLayers(composition, project, 1),
    });
    expect(plan.plans.get(`root/${text.id}`)?.samples.length).toBeGreaterThan(1);
    expect(layerMotionVectors(composition, project, text.id).some((value) => value !== 0)).toBe(
      true,
    );
  });

  it("bounds adaptive sampling and uses microsecond identities rather than frame buckets", () => {
    const { project, composition, text } = fixture();
    composition.motionBlur.samplesPerFrame = 2;
    composition.motionBlur.adaptiveSampleLimit = 12;
    const position = text.textAnimator?.groups[0]?.properties.position;
    if (!position) throw new Error("Expected text position animator");
    position[0] = {
      mode: "animated",
      keyframes: [
        { id: "huge-open", time: 0, value: -4_000, interpolation: "linear" },
        { id: "huge-close", time: 2, value: 4_000, interpolation: "linear" },
      ],
    };
    const plan = planTextMotionBlurFrame({
      composition,
      project,
      frameTime: 1,
      sceneLayers: flattenSceneLayers(composition, project, 1),
    });
    expect(plan.sampleCount).toBeGreaterThan(2);
    expect(plan.sampleCount).toBeLessThanOrEqual(12);
    expect(textMotionBlurTimeBucket(1 + 1 / 240)).not.toBe(textMotionBlurTimeBucket(1));
    expect(textMotionBlurTimeBucket(1)).toBe(TEXT_MOTION_BLUR_TIME_BUCKETS_PER_SECOND);
    expect(estimateTextAnimatorPixelTravel(text, 0, 2)).toBeGreaterThan(4_000);
  });

  it("raises adaptive sampling for out-and-back character motion with equal shutter endpoints", () => {
    const { project, composition, text } = fixture();
    composition.motionBlur.samplesPerFrame = 2;
    composition.motionBlur.adaptiveSampleLimit = 12;
    const interval = motionBlurInterval(1, 30, composition.motionBlur);
    const position = text.textAnimator?.groups[0]?.properties.position;
    if (!position) throw new Error("Expected text position animator");
    position[0] = {
      mode: "animated",
      keyframes: [
        { id: "out-back-open", time: interval.openTime, value: 0, interpolation: "linear" },
        { id: "out-back-peak", time: 1, value: 4_000, interpolation: "linear" },
        { id: "out-back-close", time: interval.closeTime, value: 0, interpolation: "linear" },
      ],
    };

    const plan = planTextMotionBlurFrame({
      composition,
      project,
      frameTime: 1,
      sceneLayers: flattenSceneLayers(composition, project, 1),
    });

    expect(estimateTextAnimatorPixelTravel(text, interval.openTime, interval.closeTime)).toBe(0);
    expect(plan.sampleCount).toBeGreaterThan(composition.motionBlur.samplesPerFrame);
    expect(plan.sampleCount).toBeLessThanOrEqual(composition.motionBlur.adaptiveSampleLimit);
  });

  it("reuses canonical base scene evaluations when adaptive sampling stays at the base count", () => {
    const { project, composition } = fixture();
    const evaluateSceneLayers = vi.fn((time: number) =>
      flattenSceneLayers(composition, project, time),
    );
    const plan = planTextMotionBlurFrame({
      composition,
      project,
      frameTime: 1,
      sceneLayers: flattenSceneLayers(composition, project, 1),
      evaluateSceneLayers,
    });

    expect(plan.sampleCount).toBe(composition.motionBlur.samplesPerFrame);
    expect(evaluateSceneLayers).toHaveBeenCalledTimes(plan.sampleCount + 2);
  });

  it("keeps isolated precomposition resource namespaces stable at every shutter sample", () => {
    const { project, composition, text } = fixture();
    const evaluateSceneLayers = (time: number) =>
      flattenSceneLayers(composition, project, time).map((scene) => ({
        ...scene,
        instanceId: `surface:wrapper/${scene.instanceId}`,
        resourceInstanceId: `surface:wrapper/${scene.resourceInstanceId}`,
      }));
    const plan = planTextMotionBlurFrame({
      composition,
      project,
      frameTime: 1,
      sceneLayers: evaluateSceneLayers(1),
      evaluateSceneLayers,
    });
    expect(plan.plans.get(`surface:wrapper/root/${text.id}`)?.samples.length).toBeGreaterThan(1);
  });

  it("samples every geometry-affecting animator property family", () => {
    const cases = {
      anchorPoint: () => ({ anchorPoint: [animated(0, 40), staticValue(0), staticValue(0)] }),
      position: () => ({ position: [animated(0, 80), staticValue(0), staticValue(0)] }),
      scale: () => ({ scale: [animated(100, 180), staticValue(100), staticValue(100)] }),
      rotation: () => ({ rotation: [staticValue(0), staticValue(0), animated(0, 90)] }),
      skew: () => ({ skew: animated(0, 35), skewAxis: animated(0, 45) }),
      tracking: () => ({ tracking: animated(0, 60) }),
      lineAnchor: () => ({ tracking: staticValue(60), lineAnchor: animated(0, 100) }),
      lineSpacing: () => ({ lineSpacing: [animated(0, 30), animated(0, 40)] }),
      characterOffset: () => ({ characterOffset: animated(0, 8) }),
      blur: () => ({ blur: [animated(0, 12), animated(0, 16)] }),
    } satisfies Record<string, () => TextAnimatorProperties>;

    for (const properties of Object.values(cases)) {
      const { project, composition, text } = fixture();
      const group = text.textAnimator?.groups[0];
      if (!group) throw new Error("Expected text animator group");
      group.properties = properties();
      const plan = planTextMotionBlurFrame({
        composition,
        project,
        frameTime: 1,
        sceneLayers: flattenSceneLayers(composition, project, 1),
      });
      expect(plan.plans.get(`root/${text.id}`)?.samples.length).toBeGreaterThan(1);
    }
  });
});

function fixture() {
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.layers = [];
  composition.motionBlur = {
    enabled: true,
    shutterAngle: 180,
    shutterPhase: -90,
    samplesPerFrame: 8,
    adaptiveSampleLimit: 32,
  };
  const text = createLayerForComposition("text", composition);
  text.motionBlur = true;
  text.inPoint = 0;
  text.outPoint = composition.duration;
  const position = text.textAnimator?.groups[0]?.properties.position;
  if (!position) throw new Error("Expected text position animator");
  position[0] = {
    mode: "animated",
    keyframes: [
      { id: "character-open", time: 0, value: 0, interpolation: "linear" },
      { id: "character-close", time: 2, value: 240, interpolation: "linear" },
    ],
  };
  composition.layers = [text];
  return { project, composition, text };
}

function layerMotionVectors(
  composition: ReturnType<typeof fixture>["composition"],
  project: ReturnType<typeof fixture>["project"],
  selectionId: string,
): Float32Array {
  const frameTime = 1;
  const frameRate = composition.frameRate.numerator / composition.frameRate.denominator;
  const interval = motionBlurInterval(frameTime, frameRate, composition.motionBlur);
  const geometryAt = (time: number) =>
    buildSceneGeometry(composition, flattenSceneLayers(composition, project, time));
  return buildTimeAddressedMotionVectors(
    geometryAt(frameTime),
    geometryAt(interval.openTime),
    geometryAt(interval.closeTime),
    new Set([selectionId]),
  );
}

function animated(from: number, to: number): Animatable {
  return {
    mode: "animated",
    keyframes: [
      { id: `open-${from}`, time: 0, value: from, interpolation: "linear" },
      { id: `close-${to}`, time: 2, value: to, interpolation: "linear" },
    ],
  };
}
