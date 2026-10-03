import { createLayerForComposition } from "../../../src/core/layers/layer-factory";
import { createBlankComposition } from "../../../src/core/project/project";
import { ANTI_ALIASING_MODES } from "../../../src/core/rendering/anti-aliasing";
import {
  BLEND_MODES,
  type Composition,
  createId,
  type ShapeSettings,
  setLayerSizeAndCenterAnchor,
  staticValue,
} from "../../../src/core/types";
import { createEffect } from "../../../src/effects/registry";
import type { GeneratedCase } from "../types";
import { caseFor, fixture } from "./base";

function geometry(kind: ShapeSettings["kind"] = "rectangle") {
  const value = fixture(`shape-${kind}`);
  const shape = value.layer("shape", "Geometry");
  setLayerSizeAndCenterAnchor(shape, [174, 92]);
  shape.color = [0.94, 0.16, 0.035, 0.85];
  shape.shape = {
    ...shape.shape,
    kind,
    roundness: 14,
    strokeWidth: 3,
    strokeColor: [0.12, 0.9, 1, 1],
    fillMode: "linear",
    gradientColor: [0.05, 0.08, 0.75, 0.35],
    gradientAngle: 27,
    dashLength: kind === "line" ? 10 : 0,
    dashGap: kind === "line" ? 5 : 0,
    lineCap: "round",
    lineJoin: "bevel",
  };
  if (kind === "bezier") {
    shape.shape.path = {
      closed: true,
      vertices: [
        { position: [0.05, 0.46], inTangent: [0, 0], outTangent: [0.12, -0.52] },
        { position: [0.63, 0.08], inTangent: [-0.2, -0.13], outTangent: [0.28, 0.24] },
        { position: [0.9, 0.91], inTangent: [0.06, -0.26], outTangent: [-0.17, 0.09] },
      ],
    };
    shape.shape.trim = { start: 4, end: 92, offset: 17 };
  }
  shape.transform.position[0] = staticValue(163.25);
  shape.transform.position[1] = staticValue(85.75);
  shape.transform.rotation[2] = staticValue(21);
  value.composition.layers = [shape];
  return value;
}

function basicLayerCases(): GeneratedCase[] {
  const nullCase = geometry();
  const parent = nullCase.layer("null", "Animated parent");
  parent.transform.position[0] = {
    mode: "animated",
    keyframes: [
      { id: createId(), time: 0, value: 120, interpolation: "linear" },
      { id: createId(), time: 2, value: 180, interpolation: "linear" },
    ],
  };
  nullCase.composition.layers[0].parentId = parent.id;
  nullCase.composition.layers.push(parent);

  const solidCase = fixture("layer-solid");
  const solid = solidCase.layer("solid");
  setLayerSizeAndCenterAnchor(solid, [152, 78]);
  solid.solid = { width: 152, height: 78, color: [0.25, 0.76, 0.12, 0.7] };
  solid.color = [...solid.solid.color];
  solid.transform.rotation[2] = staticValue(-17);
  solidCase.composition.layers = [solid];

  const textCase = fixture("layer-text");
  const text = textCase.layer("text");
  setLayerSizeAndCenterAnchor(text, [280, 100]);
  text.text = "Aster 012\nAV fi";
  if (text.textStyle) {
    Object.assign(text.textStyle, {
      fontFamily: "Arial, sans-serif",
      fontSize: 30,
      tracking: 0,
      leading: 36,
      strokeWidth: 1,
    });
  }
  text.textAnimator = undefined;
  textCase.composition.layers = [text];

  const adjustmentCase = geometry("ellipse");
  const adjustment = adjustmentCase.layer("adjustment");
  const grade = createEffect("exposure");
  grade.parameters.exposure = 0.8;
  adjustment.effects = [grade];
  adjustmentCase.composition.layers.unshift(adjustment);
  return [
    caseFor("layer-null", nullCase.project, [
      "layer:null",
      "feature:parenting",
      "feature:transforms",
    ]),
    caseFor("layer-solid", solidCase.project, ["layer:solid"], { isolated: true }),
    caseFor("layer-text", textCase.project, ["layer:text"], { isolated: true }),
    caseFor("layer-adjustment", adjustmentCase.project, [
      "layer:adjustment",
      "feature:adjustment-layers",
    ]),
  ];
}

function nestedPrecompositionCase(): GeneratedCase {
  const value = geometry("ellipse");
  const nested: Composition = {
    ...createBlankComposition("Nested source"),
    width: 320,
    height: 180,
    duration: 2,
    workArea: { start: 0, end: 2 },
    background: [0, 0, 0, 0],
    layers: value.composition.layers,
  };
  const middle: Composition = { ...nested, id: createId(), name: "Middle source", layers: [] };
  const middleLayer = createLayerForComposition("precomposition", middle);
  setLayerSizeAndCenterAnchor(middleLayer, [320, 180]);
  middleLayer.sourceCompositionId = nested.id;
  middleLayer.transform.rotation[2] = staticValue(-13);
  middle.layers = [middleLayer];
  const outer = value.layer("precomposition", "Nested surface");
  setLayerSizeAndCenterAnchor(outer, [320, 180]);
  outer.sourceCompositionId = middle.id;
  outer.effects = [createEffect("glow")];
  outer.effects[0].parameters.radius = 8;
  outer.transform.scale = [staticValue(85), staticValue(85), staticValue(100)];
  value.composition.layers = [outer];
  value.project.compositions.push(middle, nested);
  return caseFor("nested-precompositions", value.project, [
    "layer:precomposition",
    "feature:nested-precompositions",
    "feature:precomposition-surfaces",
  ]);
}

export function buildCoreCases(): GeneratedCase[] {
  const shapes = (["rectangle", "ellipse", "line", "bezier"] as const).map((kind) => {
    const value = geometry(kind);
    return caseFor(
      `shape-${kind}`,
      value.project,
      ["layer:shape", `shape:${kind}`, "feature:transforms"],
      {
        isolated: true,
      },
    );
  });
  const blends = BLEND_MODES.map((mode) => {
    const value = geometry("ellipse");
    const foreground = value.composition.layers[0];
    foreground.blendMode = mode;
    const background = value.layer("shape", "Blend backdrop");
    setLayerSizeAndCenterAnchor(background, [250, 140]);
    background.color = [0.05, 0.42, 0.11, 1];
    if (background.shape) {
      background.shape.fillMode = "linear";
      background.shape.gradientColor = [0.85, 0.12, 0.5, 0.65];
      background.shape.gradientAngle = -45;
    }
    value.composition.layers.push(background);
    return caseFor(`blend-${mode}`, value.project, [`blend:${mode}`]);
  });
  const aa = ANTI_ALIASING_MODES.map((mode) => {
    const value = geometry("bezier");
    return caseFor(`aa-${mode}`, value.project, [`aa:${mode}`], { aa: mode, isolated: true });
  });
  return [...basicLayerCases(), ...shapes, ...blends, ...aa, nestedPrecompositionCase()];
}
