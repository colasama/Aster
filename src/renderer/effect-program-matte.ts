import { evaluateEffectParameter } from "../core/timeline";
import type { Effect } from "../core/types";
import { EffectOpcode } from "./effect-opcodes";

export function compileMatteRefineEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const color = (key: string, fallback: number) => colorChannels(value(key, fallback));
  const degrees = (key: string, fallback = 0) => (value(key, fallback) * Math.PI) / 180;
  switch (effect.type) {
    case "refine-hard-matte":
      emit(EffectOpcode.RefineHardMatte, [
        value("radius", 2),
        value("edgeShift") / 100,
        value("contrast", 1.4),
        value("clipBlack", 0.03),
        value("clipWhite", 0.97),
        value("decontaminate", 35) / 100,
      ]);
      return true;
    case "refine-soft-matte":
      emit(EffectOpcode.RefineSoftMatte, [
        value("radius", 4),
        value("smoothness", 55) / 100,
        value("edgeShift") / 100,
        value("contrast", 1),
        value("decontaminate", 25) / 100,
        value("amount", 100) / 100,
      ]);
      return true;
    case "matte-feather":
      emit(EffectOpcode.MatteFeather, [
        value("radius", 12),
        value("expand") / 100,
        value("gamma", 1),
        value("opacity", 100) / 100,
        value("invert"),
      ]);
      return true;
    case "matte-cleanup":
      emit(EffectOpcode.MatteCleanup, [
        value("clipBlack", 0.04),
        value("clipWhite", 0.96),
        value("gamma", 1),
        value("radius", 2),
        value("reduceChatter", 45) / 100,
        value("fillHoles", 25) / 100,
        value("invert"),
      ]);
      return true;
    case "edge-decontaminate":
      emit(EffectOpcode.EdgeDecontaminate, [
        ...color("backgroundColor", 0x00b96b),
        value("amount", 70) / 100,
        value("radius", 3),
        value("edgeContrast", 1),
        value("preserveLuminance", 1),
      ]);
      return true;
    case "light-wrap":
      emit(EffectOpcode.LightWrap, [
        ...color("color", 0x9fd9ff),
        value("size", 18),
        value("intensity", 1),
        value("edgeWidth", 65) / 100,
        value("mode"),
        value("opacity", 75) / 100,
      ]);
      return true;
    case "alpha-bevel":
      emit(EffectOpcode.AlphaBevel, [
        value("size", 5),
        value("depth", 1.2),
        degrees("angle", 135),
        ...color("highlightColor", 0xffffff),
        value("highlightOpacity", 70) / 100,
        ...color("shadowColor", 0x10172b),
        value("shadowOpacity", 60) / 100,
      ]);
      return true;
    case "alpha-erode-dilate":
      emit(EffectOpcode.AlphaErodeDilate, [
        value("radius", 3),
        value("operation"),
        value("softness", 15) / 100,
        value("iterations", 1),
      ]);
      return true;
    default:
      return false;
  }
}

function colorChannels(value: number): [number, number, number] {
  const color = Math.max(0, Math.min(0xffffff, Math.round(value)));
  return [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255];
}
