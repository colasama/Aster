import {
  createDefaultExpressionSelector,
  createDefaultRangeSelector,
  createDefaultTextAnimatorGroup,
  createDefaultWigglySelector,
} from "../../../src/core/animation/text-animator-groups";
import {
  createId,
  createTransform,
  setLayerSizeAndCenterAnchor,
  staticValue,
} from "../../../src/core/types";
import { createEffect } from "../../../src/effects/registry";
import type { GeneratedCase } from "../types";
import { caseFor, fixture } from "./base";
import { buildGeneratorCases } from "./scene-generators";
import { motion, rectangle } from "./scene-shared";
import { buildSpatialCases } from "./scene-spatial";

export function buildSceneCases(): GeneratedCase[] {
  return [
    ...[0, 3, 4].map(maskMatteScene),
    pathMaskScene(),
    nestedScene(),
    textScene(),
    motionScene(),
    ...buildSpatialCases(),
    ...buildGeneratorCases(),
  ];
}

function maskMatteScene(channel: number): GeneratedCase {
  const id = `scene-masks-mattes-${channel}`;
  const scene = fixture(id);
  const left = rectangle(
    scene,
    "Feathered ellipse mask",
    [100, 90, 0],
    [150, 130],
    [0.12, 0.6, 0.9, 0.85],
  );
  const exposure = createEffect("exposure");
  exposure.parameters.exposure = 1.5;
  exposure.mask = {
    shape: "ellipse",
    center: [50, 50],
    size: [58, 70],
    feather: 10,
    opacity: 85,
    invert: false,
  };
  left.effects = [exposure];
  const right = rectangle(
    scene,
    "Channel matte and inverse rectangle",
    [220, 90, 0],
    [140, 125],
    [0.8, 0.14, 0.4, 1],
  );
  if (right.shape) {
    right.shape.fillMode = "linear";
    right.shape.gradientColor = [0.02, 0.7, 0.12, 0.12];
    right.shape.gradientAngle = 25;
  }
  const matte = createEffect("set-matte");
  matte.parameters.channel = channel;
  matte.parameters.threshold = 0.35;
  matte.parameters.softness = 0.25;
  const feather = createEffect("matte-feather");
  feather.parameters.radius = 3;
  const invert = createEffect("invert");
  invert.mask = {
    shape: "rectangle",
    center: [52, 50],
    size: [55, 45],
    feather: 4,
    opacity: 100,
    invert: true,
  };
  right.effects = [matte, feather, invert];
  scene.composition.layers = [right, left];
  return caseFor(id, scene.project, ["layer:shape", "feature:masks", "feature:mattes"]);
}

function pathMaskScene(): GeneratedCase {
  const scene = fixture("scene-path-mask-reference");
  const shape = rectangle(
    scene,
    "Reusable path mask",
    [160, 90, 0],
    [190, 130],
    [0.15, 0.55, 0.95, 1],
  );
  const pathId = createId();
  shape.shapeGraph = {
    id: createId(),
    revision: 1,
    paths: [
      {
        id: pathId,
        revision: 1,
        path: {
          closed: true,
          vertices: [
            [0.1, 0.15],
            [0.85, 0.25],
            [0.65, 0.9],
            [0.2, 0.65],
          ].map(([x, y]) => ({ position: [x, y], inTangent: [0, 0], outTangent: [0, 0] })),
        },
      },
    ],
    groups: [],
    rootGroupIds: [],
  };
  const effect = createEffect("exposure");
  effect.parameters.exposure = 1.5;
  effect.mask = {
    shape: "path",
    pathId,
    center: [50, 50],
    size: [70, 70],
    feather: 5,
    opacity: 100,
    invert: false,
  };
  shape.effects = [effect];
  scene.composition.layers = [shape];
  return caseFor(
    "scene-path-mask-reference",
    scene.project,
    ["layer:shape", "feature:path-mask-schema"],
    { isolated: true },
  );
}

function nestedScene(): GeneratedCase {
  const scene = fixture("scene-nested-adjustment");
  const middle = fixture("nested-middle");
  const inner = fixture("nested-inner");
  inner.composition.background = [0, 0, 0, 0];
  middle.composition.background = [0, 0, 0, 0];
  const disc = rectangle(
    inner,
    "Animated inner disc",
    [100, 90, 0],
    [86, 86],
    [0.1, 0.65, 0.9, 0.8],
  );
  if (disc.shape) disc.shape.kind = "ellipse";
  disc.transform.position[0] = motion(80, 230);
  inner.composition.layers = [
    disc,
    rectangle(inner, "Inner card", [160, 90, 0], [235, 110], [0.55, 0.08, 0.12, 0.8]),
  ];
  const innerWrapper = middle.layer("precomposition", "Inner source");
  innerWrapper.sourceCompositionId = inner.composition.id;
  setLayerSizeAndCenterAnchor(innerWrapper, [320, 180]);
  innerWrapper.transform.position = [staticValue(160), staticValue(90), staticValue(0)];
  innerWrapper.effects = [createEffect("gaussian-blur")];
  innerWrapper.effects[0].parameters.radius = 2;
  const adjustment = middle.layer("adjustment", "Nested color adjustment");
  adjustment.effects = [createEffect("exposure")];
  adjustment.effects[0].parameters.exposure = 0.55;
  middle.composition.layers = [adjustment, innerWrapper];
  const outer = scene.layer("precomposition", "Surface with nested adjustment");
  outer.sourceCompositionId = middle.composition.id;
  setLayerSizeAndCenterAnchor(outer, [320, 180]);
  outer.transform.position = [staticValue(160), staticValue(90), staticValue(0)];
  outer.transform.rotation[2] = motion(-8, 8);
  outer.transform.scale = [staticValue(85), staticValue(85), staticValue(100)];
  outer.timeStretch = 1.25;
  outer.blendMode = "soft-light";
  const glow = createEffect("glow");
  glow.parameters.radius = 6;
  glow.parameters.intensity = 0.3;
  // An effect-bearing wrapper owns the surface required by nested adjustment layers.
  outer.effects = [glow];
  const foreground = rectangle(
    scene,
    "Unaffected foreground",
    [255, 45, 0],
    [34, 30],
    [1, 0.7, 0.1, 1],
  );
  scene.composition.layers = [
    foreground,
    outer,
    rectangle(scene, "Backdrop blend receiver", [160, 90, 0], [290, 150], [0.08, 0.28, 0.55, 1]),
  ];
  scene.project.compositions.push(middle.composition, inner.composition);
  return caseFor("scene-nested-adjustment", scene.project, [
    "layer:precomposition",
    "layer:adjustment",
    "feature:nested-precompositions",
    "feature:adjustment-layers",
    "feature:backdrop-blends",
  ]);
}

function textScene(): GeneratedCase {
  const scene = fixture("scene-text-animators");
  const text = scene.layer("text", "Latin CJK Arabic combining text");
  text.text = "Aster e\u0301\n日本語 中文\nالعربية";
  setLayerSizeAndCenterAnchor(text, [280, 150]);
  text.transform = createTransform([160, 90, 0], [140, 75, 0]);
  text.textStyle = {
    fontFamily: "Segoe UI, Yu Gothic, Microsoft YaHei, sans-serif",
    fontSize: 25,
    fontWeight: 400,
    alignment: "center",
    tracking: 0,
    leading: 38,
    strokeWidth: 0.5,
    strokeColor: [0.12, 0.08, 0.2, 1],
  };
  const range = createDefaultRangeSelector();
  range.end = motion(10, 100);
  range.shape = "smooth";
  range.smoothness = staticValue(65);
  const expression = createDefaultExpressionSelector();
  expression.expression = "50 + 50 * sin(time * 3 + textIndex * 0.5)";
  expression.mode = "intersect";
  const first = createDefaultTextAnimatorGroup();
  first.selectors = [range, expression];
  first.properties = {
    position: [staticValue(0), staticValue(-12), staticValue(0)],
    rotation: [staticValue(0), staticValue(0), staticValue(8)],
    fillColor: [staticValue(0.2), staticValue(0.8), staticValue(1), staticValue(1)],
  };
  const second = createDefaultTextAnimatorGroup(1);
  const wiggly = createDefaultWigglySelector();
  wiggly.randomSeed = 912;
  wiggly.wigglesPerSecond = staticValue(1.5);
  second.selectors = [wiggly];
  second.properties = {
    tracking: staticValue(1.5),
    scale: [staticValue(105), staticValue(95), staticValue(100)],
  };
  text.textAnimator = { enabled: true, groups: [first, second] };
  scene.composition.layers = [text];
  return caseFor(
    "scene-text-animators",
    scene.project,
    ["layer:text", "feature:text-animators", "feature:text-multiscript"],
    { isolated: true },
  );
}

function motionScene(): GeneratedCase {
  const scene = fixture("scene-motion-blur");
  scene.composition.motionBlur = {
    enabled: true,
    shutterAngle: 270,
    shutterPhase: -135,
    samplesPerFrame: 8,
    adaptiveSampleLimit: 16,
  };
  const moving = rectangle(
    scene,
    "Moving high contrast bar",
    [50, 85, 0],
    [16, 105],
    [1, 0.55, 0.06, 1],
  );
  moving.motionBlur = true;
  moving.transform.position[0] = motion(45, 275);
  moving.transform.rotation[2] = motion(-35, 60);
  const text = scene.layer("text", "Moving text raster");
  text.text = "ASTER";
  setLayerSizeAndCenterAnchor(text, [180, 44]);
  text.transform = createTransform([160, 135, 0], [90, 22, 0]);
  text.transform.position[0] = motion(230, 90);
  text.textStyle = {
    fontFamily: "Segoe UI, sans-serif",
    fontSize: 30,
    fontWeight: 700,
    alignment: "center",
    tracking: 0,
    leading: 36,
    strokeWidth: 0,
    strokeColor: [0, 0, 0, 1],
  };
  text.textAnimator = { enabled: false, groups: [] };
  text.motionBlur = true;
  scene.composition.layers = [text, moving];
  return caseFor(
    "scene-motion-blur",
    scene.project,
    ["layer:shape", "layer:text", "feature:motion-blur", "feature:text-motion-blur"],
    { frames: [5, 15, 30, 54], sequence: true },
  );
}
