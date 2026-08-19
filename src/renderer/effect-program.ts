import { visibleLayersAtTime } from "../core/scene-evaluation";
import type { Composition, Effect, Layer } from "../core/types";

export const MAX_EFFECT_OPERATIONS = 64;
export const FLOATS_PER_EFFECT_OPERATION = 16;

export enum EffectOpcode {
  Mosaic = 1,
  Posterize = 2,
  Tint = 3,
  ChannelMixer = 4,
  Twirl = 5,
  Bulge = 6,
  WaveWarp = 7,
  FindEdges = 8,
  Emboss = 9,
  LinearWipe = 10,
  RadialWipe = 11,
  SplitTone = 12,
  Checkerboard = 13,
  Grid = 14,
  FourColorGradient = 15,
  FractalNoise = 16,
  Sharpen = 17,
  DirectionalBlur = 18,
  RadialBlur = 19,
  ChromaKey = 20,
  LumaKey = 21,
  SpillSuppressor = 22,
  ColorBalance = 23,
  Transform = 24,
  TurbulentDisplace = 25,
  Displacement = 26,
  Levels = 27,
  Curves = 28,
  Minimax = 29,
  PosterizeTime = 30,
  HueSaturation = 31,
  Lut = 32,
}

export interface EffectProgram {
  data: Float32Array;
  count: number;
}

export function compileEffectProgram(
  composition: Composition,
  time = 0,
  layers: Layer[] = visibleLayersAtTime(composition, time),
): EffectProgram {
  const values = new Float32Array(MAX_EFFECT_OPERATIONS * FLOATS_PER_EFFECT_OPERATION);
  let count = 0;
  const emit = (opcode: EffectOpcode, parameters: number[]) => {
    if (count >= MAX_EFFECT_OPERATIONS) return;
    const offset = count * FLOATS_PER_EFFECT_OPERATION;
    values[offset] = opcode;
    values.set(parameters.slice(0, FLOATS_PER_EFFECT_OPERATION - 1), offset + 1);
    count += 1;
  };
  for (const layer of [...layers].reverse()) {
    for (const effect of layer.effects) {
      if (effect.enabled) compileEffect(effect, emit);
    }
  }
  return { data: values, count };
}

function compileEffect(
  effect: Effect,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): void {
  const value = (key: string, fallback = 0) => effect.parameters[key] ?? fallback;
  const color = (key: string, fallback: number) => colorChannels(value(key, fallback));
  switch (effect.type) {
    case "mosaic":
      emit(EffectOpcode.Mosaic, [value("blocksX", 64), value("blocksY", 36)]);
      break;
    case "posterize":
      emit(EffectOpcode.Posterize, [value("levels", 8)]);
      break;
    case "tint":
      emit(EffectOpcode.Tint, [
        ...color("black", 0x152446),
        value("amount", 100) / 100,
        ...color("white", 0xdce8ff),
      ]);
      break;
    case "channel-mixer":
      emit(EffectOpcode.ChannelMixer, [
        value("red", 1),
        value("green", 1),
        value("blue", 1),
        value("monochrome"),
      ]);
      break;
    case "twirl":
      emit(EffectOpcode.Twirl, [degrees(value("angle", 60)), value("radius", 280)]);
      break;
    case "bulge":
      emit(EffectOpcode.Bulge, [value("radius", 300), value("height", 0.5), value("taper", 1)]);
      break;
    case "wave-warp":
      emit(EffectOpcode.WaveWarp, [
        value("height", 24),
        value("width", 320),
        degrees(value("direction", 90)),
        value("speed", 1),
      ]);
      break;
    case "find-edges":
      emit(EffectOpcode.FindEdges, [value("invert"), value("blend") / 100]);
      break;
    case "emboss":
      emit(EffectOpcode.Emboss, [
        degrees(value("direction", 135)),
        value("relief", 2),
        value("contrast", 1),
        value("blend") / 100,
      ]);
      break;
    case "linear-wipe":
      emit(EffectOpcode.LinearWipe, [
        value("completion", 50) / 100,
        degrees(value("angle")),
        value("feather"),
      ]);
      break;
    case "radial-wipe":
      emit(EffectOpcode.RadialWipe, [
        value("completion", 50) / 100,
        degrees(value("startAngle")),
        degrees(value("feather")),
      ]);
      break;
    case "split-tone":
      emit(EffectOpcode.SplitTone, [
        degrees(value("shadowHue", 220)),
        value("shadowAmount", 0.12),
        degrees(value("highlightHue", 38)),
        value("highlightAmount", 0.1),
        value("balance"),
      ]);
      break;
    case "checkerboard":
      emit(EffectOpcode.Checkerboard, [
        value("size", 80),
        value("opacity", 100) / 100,
        0,
        ...color("color1", 0x141824),
        0,
        ...color("color2", 0x334267),
      ]);
      break;
    case "grid":
      emit(EffectOpcode.Grid, [
        value("width", 120),
        value("height", 120),
        value("border", 2),
        ...color("color", 0x6f86b7),
      ]);
      break;
    case "four-color-gradient":
      emit(EffectOpcode.FourColorGradient, [
        ...color("color1", 0x172968),
        value("blend", 0.5),
        ...color("color2", 0x723dd8),
        0,
        ...color("color3", 0x189bc0),
        0,
        ...color("color4", 0x0b1029),
      ]);
      break;
    case "fractal-noise":
      emit(EffectOpcode.FractalNoise, [
        value("contrast", 1.2),
        value("brightness"),
        value("scale", 180),
        value("complexity", 4),
        value("evolution"),
      ]);
      break;
    case "sharpen":
      emit(EffectOpcode.Sharpen, [
        value("amount", 60) / 100,
        value("radius", 1.5),
        value("threshold") / 255,
      ]);
      break;
    case "directional-blur":
      emit(EffectOpcode.DirectionalBlur, [value("length", 24), degrees(value("direction"))]);
      break;
    case "radial-blur":
      emit(EffectOpcode.RadialBlur, [value("amount", 12) / 100, value("mode")]);
      break;
    case "chroma-key":
      emit(EffectOpcode.ChromaKey, [
        ...color("keyColor", 0x00ff65),
        value("tolerance", 0.18),
        value("softness", 0.08),
        value("spill", 0.6),
      ]);
      break;
    case "luma-key":
      emit(EffectOpcode.LumaKey, [value("mode"), value("threshold", 0.5), value("softness", 0.1)]);
      break;
    case "spill-suppressor":
      emit(EffectOpcode.SpillSuppressor, [value("color"), value("amount", 1), value("range", 0.5)]);
      break;
    case "color-balance":
      emit(EffectOpcode.ColorBalance, [
        value("shadows"),
        value("midtones"),
        value("highlights"),
        value("preserveLuminosity", 1),
      ]);
      break;
    case "transform":
      emit(EffectOpcode.Transform, [
        value("positionX"),
        value("positionY"),
        value("scale", 100) / 100,
        degrees(value("rotation")),
      ]);
      break;
    case "turbulent-displace":
      emit(EffectOpcode.TurbulentDisplace, [
        value("amount", 50),
        value("size", 100),
        value("complexity", 2),
        value("evolution"),
      ]);
      break;
    case "displacement-map":
      emit(EffectOpcode.Displacement, [value("horizontal", 25), value("vertical", 25)]);
      break;
    case "levels":
      emit(EffectOpcode.Levels, [
        value("inputBlack"),
        value("inputWhite", 1),
        value("gamma", 1),
        value("outputBlack"),
        value("outputWhite", 1),
      ]);
      break;
    case "curves":
      emit(EffectOpcode.Curves, [value("shadows"), value("midtones"), value("highlights")]);
      break;
    case "minimax":
      emit(EffectOpcode.Minimax, [value("radius", 2), value("operation"), value("channel")]);
      break;
    case "posterize-time":
      emit(EffectOpcode.PosterizeTime, [value("frameRate", 12)]);
      break;
    case "hue-saturation":
      emit(EffectOpcode.HueSaturation, [
        degrees(value("hue")),
        value("saturation", 1),
        value("lightness"),
      ]);
      break;
    case "lut":
      emit(EffectOpcode.Lut, [value("intensity", 100) / 100, value("interpolation")]);
      break;
  }
}

function colorChannels(value: number): [number, number, number] {
  const color = Math.max(0, Math.min(0xffffff, Math.round(value)));
  return [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255];
}

function degrees(value: number): number {
  return (value * Math.PI) / 180;
}
