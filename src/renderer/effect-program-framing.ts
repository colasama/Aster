import { evaluateEffectParameter } from "../core/timeline";
import type { Effect } from "../core/types";
import { EffectOpcode } from "./effect-opcodes";

export function compileFramingEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  switch (effect.type) {
    case "crop":
      emit(EffectOpcode.Crop, [
        value("left") / 100,
        value("right") / 100,
        value("top") / 100,
        value("bottom") / 100,
        value("feather"),
        value("invert"),
      ]);
      return true;
    case "letterbox":
      emit(EffectOpcode.Letterbox, [
        value("aspect"),
        value("customRatio", 2),
        ...colorChannels(value("color")),
        value("opacity", 100) / 100,
        value("feather"),
        value("blend", 100) / 100,
      ]);
      return true;
    case "edge-feather":
      emit(EffectOpcode.EdgeFeather, [
        value("width", 72),
        value("shape"),
        value("curve", 1.4),
        value("amount", 100) / 100,
      ]);
      return true;
    case "overscan":
      emit(EffectOpcode.Overscan, [
        value("scale", 103) / 100,
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("mirrorEdges", 1),
        value("blend", 100) / 100,
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
