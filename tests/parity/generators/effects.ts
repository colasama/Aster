import { createBlankComposition } from "../../../src/core/project/project";
import {
  type Composition,
  createId,
  type Effect,
  type Layer,
  setLayerSizeAndCenterAnchor,
  staticValue,
} from "../../../src/core/types";
import { createEffect, EFFECT_REGISTRY } from "../../../src/effects/registry";
import { parseCubeLut } from "../../../src/effects/resources/cube-lut";
import type { GeneratedCase } from "../types";
import { caseFor, fixture } from "./base";

// Identity defaults and output-sized generators need explicit activation at this fixture resolution.
const ACTIVATION: Record<string, Record<string, number>> = {
  "brightness-contrast": { brightness: 0.16, contrast: 1.25 },
  exposure: { exposure: 0.75 },
  "hue-saturation": { hue: 38, saturation: 0.7 },
  levels: { inputBlack: 0.12, inputWhite: 0.86, gamma: 1.3 },
  curves: { shadows: -0.14, midtones: 0.22, highlights: 0.12 },
  vibrance: { vibrance: 0.55 },
  "color-balance": { shadows: 0.22, highlights: -0.18 },
  "color-matrix": { gain: 1.25, saturation: 0.6 },
  "channel-mixer": { red: 0.65, green: 1.25, blue: 0.8 },
  transform: { positionX: 12, positionY: -7, scale: 87, rotation: 14 },
  "vr-rotate-sphere": { yaw: 35, pitch: 12, roll: -8 },
  offset: { shiftX: 17, shiftY: -11 },
  "corner-pin": { upperLeftX: 12, upperRightY: 15, lowerRightX: 85 },
  crop: { left: 24, right: 19, top: 17, bottom: 12, feather: 4 },
  "selective-color": { cyan: -28, magenta: 24, yellow: 16 },
  "gamma-pedestal-gain": { gamma: 1.25, pedestal: 0.04, blueGain: 0.8 },
  "broadcast-colors": { maximumSignal: 0.45 },
  "white-balance": { temperature: 0.35, tint: -0.15 },
  "printer-lights": { red: 4, green: -2, blue: 3 },
  "set-channels": { red: 2, green: 0, blue: 1 },
  "alpha-levels": { inputBlack: 0.15, inputWhite: 0.8, gamma: 1.3 },
  "hdr-clamp": { minimum: 0.1, maximum: 0.6 },
  "asc-cdl": { slopeR: 1.2, offsetG: 0.06, powerB: 1.3 },
  "rgb-lift-gamma-gain": { liftR: 0.05, gammaG: 1.25, gainB: 0.75 },
  "log-wheels": { shadowAmount: 0.16, midtoneAmount: 0.12, highlightAmount: -0.08 },
  "hsl-secondary": { hueCenter: 135, hueRange: 80, hueShift: 45, saturation: 0.5 },
  "bezier-warp": { topBend: 16, bottomBend: -12, leftBend: 8 },
  griddler: { tileWidth: 64, tileHeight: 48, rotation: 17, offsetX: 11 },
  "power-pin": { upperLeftX: 10, upperRightY: 12, lowerLeftX: 18 },
  "frequency-separation": { detail: 1.8 },
  "filmic-tone-map": { curve: 1, exposure: 0.8 },
  circle: { radius: 48, thickness: 8 },
  ellipse: { width: 140, height: 80, thickness: 7 },
  "star-burst": { radius: 80 },
  magnify: { size: 72, feather: 12 },
  "chroma-key": { keyColor: 0x00ff66, tolerance: 0.3 },
  "linear-color-key": { keyColor: 0x00ff66, tolerance: 0.3 },
  "change-to-color": { fromColor: 0x00ff66, tolerance: 0.3 },
  "color-range": { targetColor: 0x00ff66, fuzziness: 0.3 },
  keylight: { screenColor: 0x00ff66 },
  "spill-killer": { screenColor: 0x00ff66 },
  "head-switching": { height: 32 },
  "eyedropper-fill": { sampleX: 50, sampleY: 30 },
  "paint-bucket": { seedX: 50, seedY: 30 },
};

function activatedEffect(type: string): Effect {
  const effect = createEffect(type);
  Object.assign(effect.parameters, ACTIVATION[type]);
  if (type === "lut") {
    const rows: string[] = [];
    for (let blue = 0; blue <= 2; blue += 1) {
      for (let green = 0; green <= 2; green += 1) {
        for (let red = 0; red <= 2; red += 1) {
          const r = red / 2;
          const g = green / 2;
          const b = blue / 2;
          rows.push(
            `${0.06 + r * 0.72 + g * b * 0.18} ${g ** 1.3 * 0.85} ${b * 0.8 + r * g * 0.15}`,
          );
        }
      }
    }
    effect.resource = parseCubeLut(
      `TITLE "Parity cross-channel LUT"\nLUT_3D_SIZE 3\n${rows.join("\n")}`,
      "parity.cube",
    );
  }
  return effect;
}

function inputPlate(id: string) {
  const value = fixture(id);
  const colors: Layer["color"][] = [
    [0.015, 0.015, 0.015, 1],
    [0.42, 0.42, 0.42, 1],
    [0.98, 0.98, 0.98, 1],
    [0.95, 0.1, 0.03, 0.8],
    [0, 1, 0.4, 1],
    [0.05, 0.12, 0.95, 0.45],
  ];
  const layers = colors.map((color, index) => {
    const layer = value.layer("shape", `Color patch ${index}`);
    setLayerSizeAndCenterAnchor(layer, [62, 54]);
    layer.color = color;
    layer.transform.position[0] = staticValue(74 + (index % 3) * 85);
    layer.transform.position[1] = staticValue(index < 3 ? 52 : 125);
    if (layer.shape) {
      layer.shape.kind = index % 2 ? "ellipse" : "rectangle";
      layer.shape.roundness = 8;
      layer.shape.fillMode = "linear";
      layer.shape.gradientColor = [color[0] * 0.45, color[1] * 0.45, color[2] * 0.45, 0.15];
      layer.shape.gradientAngle = 35;
      layer.shape.strokeWidth = 1.5;
      layer.shape.strokeColor = [...color];
    }
    return layer;
  });
  for (let index = 0; index < 10; index += 1) {
    const detail = value.layer("shape", `Fine detail ${index}`);
    setLayerSizeAndCenterAnchor(detail, [index % 2 ? 2 : 1, 20 + index]);
    detail.color = index % 2 ? [1, 1, 1, 0.9] : [0.01, 0.01, 0.01, 0.65];
    detail.transform.position[0] = staticValue(122 + index * 3);
    detail.transform.position[1] = staticValue(90);
    layers.unshift(detail);
  }
  const moving = value.layer("shape", "Moving temporal witness");
  setLayerSizeAndCenterAnchor(moving, [13, 13]);
  moving.color = [1, 0.7, 0.03, 1];
  moving.transform.position[0] = {
    mode: "animated",
    keyframes: [
      { id: createId(), time: 0, value: 38, interpolation: "linear" },
      { id: createId(), time: 2, value: 282, interpolation: "linear" },
    ],
  };
  moving.transform.position[1] = staticValue(90);
  layers.unshift(moving);
  const source: Composition = {
    ...createBlankComposition("Color and alpha input"),
    width: 320,
    height: 180,
    duration: 2,
    workArea: { start: 0, end: 2 },
    background: [0, 0, 0, 0],
    layers,
  };
  const surface = value.layer("precomposition", "Effect under test");
  setLayerSizeAndCenterAnchor(surface, [320, 180]);
  surface.sourceCompositionId = source.id;
  value.project.compositions.push(source);
  value.composition.layers = [surface];
  return { ...value, surface };
}

export function buildEffectCases(): GeneratedCase[] {
  const cases = EFFECT_REGISTRY.map((definition) => {
    const id = `effect-${definition.type}`;
    const value = inputPlate(id);
    value.surface.effects = [activatedEffect(definition.type)];
    const temporal = definition.execution === "temporal";
    const features = [`effect:${definition.type}`];
    if (definition.category === "Layer Styles") features.push("feature:layer-styles");
    if (definition.type === "lut") features.push("lut:trilinear");
    if (definition.type === "filmic-tone-map") features.push("feature:filmic");
    return caseFor(id, value.project, features, {
      isolated: true,
      ...(temporal ? { sequence: true, frames: [1, 2, 17, 31, 58] } : {}),
    });
  });
  const tetrahedral = inputPlate("lut-tetrahedral");
  const lut = activatedEffect("lut");
  lut.parameters.interpolation = 1;
  tetrahedral.surface.effects = [lut];
  cases.push(
    caseFor("lut-tetrahedral", tetrahedral.project, ["effect:lut", "lut:tetrahedral"], {
      isolated: true,
    }),
  );

  const aces = inputPlate("filmic-aces");
  const toneMap = activatedEffect("filmic-tone-map");
  toneMap.parameters.curve = 0;
  toneMap.parameters.exposure = 1.2;
  aces.surface.effects = [toneMap];
  cases.push(
    caseFor("filmic-aces", aces.project, ["effect:filmic-tone-map", "feature:aces"], {
      isolated: true,
    }),
  );

  const chain = inputPlate("effects-layer-style-chain");
  chain.surface.effects = [
    "exposure",
    "gaussian-blur",
    "glow",
    "outer-glow",
    "inner-shadow",
    "alpha-stroke",
  ].map(activatedEffect);
  chain.surface.effects[1].parameters.radius = 3;
  chain.surface.effects[2].parameters.radius = 12;
  cases.push(
    caseFor(
      "effects-layer-style-chain",
      chain.project,
      ["feature:layer-styles", "feature:effect-chain"],
      { isolated: true },
    ),
  );

  for (const shape of ["ellipse", "rectangle"] as const) {
    const value = inputPlate(`effect-mask-${shape}`);
    const effect = activatedEffect("exposure");
    effect.mask = {
      shape,
      center: [50, 50],
      size: [65, 65],
      feather: 8,
      opacity: 80,
      invert: shape === "rectangle",
    };
    value.surface.effects = [effect];
    cases.push(
      caseFor(`effect-mask-${shape}`, value.project, ["feature:effect-masks", `mask:${shape}`], {
        isolated: true,
      }),
    );
  }
  return cases;
}
