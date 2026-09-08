import { evaluateEffectParameter } from "../../../core/animation/timeline";
import type { Effect } from "../../../core/types";
import { EffectOpcode } from "../effect-opcodes";

export function compileChannelKeyingEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const color = (key: string, fallback: number) => colorChannels(value(key, fallback));
  switch (effect.type) {
    case "set-channels":
      emit(EffectOpcode.SetChannels, [
        value("red"),
        value("green", 1),
        value("blue", 2),
        value("alpha", 3),
      ]);
      return true;
    case "arithmetic":
      emit(EffectOpcode.Arithmetic, [
        value("operator"),
        value("value", 0.1),
        value("clamp", 1),
        value("blend", 100) / 100,
      ]);
      return true;
    case "alpha-levels":
      emit(EffectOpcode.AlphaLevels, [
        value("inputBlack"),
        value("inputWhite", 1),
        value("gamma", 1),
        value("outputBlack"),
        value("outputWhite", 1),
        value("invert"),
      ]);
      return true;
    case "remove-color-matting":
      emit(EffectOpcode.RemoveColorMatting, [
        ...color("backgroundColor", 0x000000),
        value("amount", 100) / 100,
        value("preserveLuminance", 1),
      ]);
      return true;
    case "linear-color-key":
      emit(EffectOpcode.LinearColorKey, [
        ...color("keyColor", 0x00ff66),
        value("tolerance", 0.18),
        value("softness", 0.08),
        value("invert"),
      ]);
      return true;
    case "color-range":
      emit(EffectOpcode.ColorRange, [
        ...color("targetColor", 0x3d65ff),
        value("fuzziness", 0.22),
        value("minimumLuminance"),
        value("maximumLuminance", 1),
        value("softness", 0.08),
        value("invert"),
      ]);
      return true;
    case "matte-choker":
      emit(EffectOpcode.MatteChoker, [
        value("choke", 4),
        value("softness", 2),
        value("geometry"),
        value("iterations", 1),
      ]);
      return true;
    case "keylight":
      emit(EffectOpcode.Keylight, [
        ...color("screenColor", 0x00b96b),
        value("screenGain", 1),
        value("screenBalance", 0.5),
        value("clipBlack", 0.04),
        value("clipWhite", 0.92),
        value("screenSoftness", 0.08),
        value("despill", 0.75),
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
