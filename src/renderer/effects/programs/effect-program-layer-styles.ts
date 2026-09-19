import { evaluateEffectParameter } from "../../../core/animation/timeline";
import type { Effect } from "../../../core/types";
import { EffectOpcode } from "../effect-opcodes";

export function compileLayerStyleEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const color = (key: string, fallback: number) => colorChannels(value(key, fallback));
  const degrees = (key: string, fallback = 0) => (value(key, fallback) * Math.PI) / 180;
  switch (effect.type) {
    case "outer-glow":
      emit(EffectOpcode.OuterGlow, [
        ...color("color", 0x58b9ff),
        value("opacity", 75) / 100,
        value("size", 24),
        value("spread", 12) / 100,
        value("range", 0.5),
      ]);
      return true;
    case "inner-glow":
      emit(EffectOpcode.InnerGlow, [
        ...color("color", 0xffffff),
        value("opacity", 65) / 100,
        value("size", 18),
        value("choke", 8) / 100,
        value("center"),
      ]);
      return true;
    case "alpha-stroke":
      emit(EffectOpcode.AlphaStroke, [
        ...color("color", 0x6da6ff),
        value("opacity", 100) / 100,
        value("size", 6),
        value("position"),
      ]);
      return true;
    case "inner-shadow":
      emit(EffectOpcode.InnerShadow, [
        ...color("color", 0x08101f),
        value("opacity", 65) / 100,
        degrees("angle", 135),
        value("distance", 12),
        value("size", 12),
        value("choke") / 100,
      ]);
      return true;
    case "bevel-emboss-style":
      emit(EffectOpcode.BevelEmbossStyle, [
        value("style"),
        value("depth", 100) / 100,
        value("size", 8),
        degrees("angle", 135),
        ...color("highlightColor", 0xffffff),
        value("highlightOpacity", 75) / 100,
        ...color("shadowColor", 0x10172b),
        value("shadowOpacity", 65) / 100,
      ]);
      return true;
    case "satin":
      emit(EffectOpcode.Satin, [
        ...color("color", 0x31568f),
        value("opacity", 45) / 100,
        degrees("angle", 19),
        value("distance", 14),
        value("size", 18),
        value("invert"),
      ]);
      return true;
    case "color-overlay":
      emit(EffectOpcode.ColorOverlay, [
        ...color("color", 0x6d72ff).map(
          (channel) => channel * Math.max(0, Math.min(16, value("intensity", 1))),
        ),
        value("opacity", 65) / 100,
        value("blendMode"),
      ]);
      return true;
    case "gradient-overlay":
      emit(EffectOpcode.GradientOverlay, [
        ...color("startColor", 0x283d8f),
        degrees("angle", 90),
        ...color("endColor", 0xff78c8),
        value("scale", 100) / 100,
        value("opacity", 75) / 100,
        value("blendMode"),
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
