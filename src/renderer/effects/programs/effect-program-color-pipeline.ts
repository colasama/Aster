import { evaluateEffectParameter } from "../../../core/animation/timeline";
import type { Effect } from "../../../core/types";
import { EffectOpcode } from "../effect-opcodes";

export function compileColorPipelineEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const degrees = (key: string, fallback = 0) => (value(key, fallback) * Math.PI) / 180;
  const blend = () => value("blend", 100) / 100;
  switch (effect.type) {
    case "printer-lights":
      emit(EffectOpcode.PrinterLights, [
        value("red"),
        value("green"),
        value("blue"),
        value("master"),
        value("pointSize", 0.025),
        blend(),
      ]);
      return true;
    case "hue-vs-hue":
      emit(EffectOpcode.HueVsHue, [
        degrees("center"),
        degrees("range", 35),
        degrees("shift", 18),
        value("softness", 0.12),
        blend(),
      ]);
      return true;
    case "hue-vs-saturation":
      emit(EffectOpcode.HueVsSaturation, [
        degrees("center"),
        degrees("range", 35),
        value("saturation", 1.2),
        value("softness", 0.12),
        blend(),
      ]);
      return true;
    case "luma-vs-saturation":
      emit(EffectOpcode.LumaVsSaturation, [
        value("shadows", 0.75),
        value("midtones", 1),
        value("highlights", 0.85),
        value("shadowEnd", 0.28),
        value("highlightStart", 0.68),
        blend(),
      ]);
      return true;
    case "shadow-desaturate":
      emit(EffectOpcode.ShadowDesaturate, [
        value("threshold", 0.22),
        value("softness", 0.14),
        value("saturation", 0.35),
        blend(),
      ]);
      return true;
    case "highlight-tint":
      emit(EffectOpcode.HighlightTint, [
        value("threshold", 0.72),
        value("softness", 0.18),
        ...colorChannels(value("color", 0xffc27c)),
        value("amount", 28) / 100,
        value("preserveLuminance", 1),
        blend(),
      ]);
      return true;
    case "filmic-tone-map":
      emit(EffectOpcode.FilmicToneMap, [
        value("curve"),
        value("exposure"),
        value("whitePoint", 4),
        value("toe", 0.08),
        value("shoulder", 0.18),
        value("saturation", 1),
        blend(),
      ]);
      return true;
    case "skin-tone-refine":
      emit(EffectOpcode.SkinToneRefine, [
        degrees("center", 32),
        degrees("range", 28),
        value("softness", 0.16),
        value("saturation", 1.04),
        value("lightness", 0.015),
        value("warmth", 0.035),
        blend(),
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
