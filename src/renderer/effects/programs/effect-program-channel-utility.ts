import { evaluateEffectParameter } from "../../../core/animation/timeline";
import type { Effect } from "../../../core/types";
import { EffectOpcode } from "../effect-opcodes";

export function compileChannelUtilityEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  switch (effect.type) {
    case "shift-channels":
      emit(EffectOpcode.ShiftChannels, [
        value("alphaSource", 4),
        value("invert"),
        value("preserveRgb", 1),
        value("blend", 100) / 100,
      ]);
      return true;
    case "channel-combiner":
      emit(EffectOpcode.ChannelCombiner, [value("operation"), value("blend", 100) / 100]);
      return true;
    case "solid-composite":
      emit(EffectOpcode.SolidComposite, [
        ...colorChannels(value("color", 0x101521)),
        value("opacity", 100) / 100,
      ]);
      return true;
    case "premultiply-color":
      emit(EffectOpcode.PremultiplyColor, [value("amount", 100) / 100]);
      return true;
    case "unpremultiply-color":
      emit(EffectOpcode.UnpremultiplyColor, [
        value("alphaFloor", 0.01),
        value("amount", 100) / 100,
      ]);
      return true;
    case "alpha-from-luminance":
      emit(EffectOpcode.AlphaFromLuminance, [
        value("black"),
        value("white", 1),
        value("gamma", 1),
        value("invert"),
        value("combine"),
        value("blend", 100) / 100,
      ]);
      return true;
    case "set-matte":
      emit(EffectOpcode.SetMatte, [
        value("channel", 3),
        value("threshold", 0.5),
        value("softness", 0.1),
        value("invert"),
        value("blend", 100) / 100,
      ]);
      return true;
    case "hdr-clamp":
      emit(EffectOpcode.HdrClamp, [
        value("minimum"),
        value("maximum", 1),
        value("softKnee", 0.1),
        value("luminanceOnly"),
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
