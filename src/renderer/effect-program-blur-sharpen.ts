import { evaluateEffectParameter } from "../core/timeline";
import type { Effect } from "../core/types";
import { EffectOpcode } from "./effect-opcodes";

export function compileBlurSharpenEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  switch (effect.type) {
    case "channel-blur":
      emit(EffectOpcode.ChannelBlur, [
        value("red", 8),
        value("green", 8),
        value("blue", 8),
        value("alpha"),
      ]);
      return true;
    case "cross-blur":
      emit(EffectOpcode.CrossBlur, [
        value("horizontal", 18),
        value("vertical", 18),
        value("blend", 100) / 100,
      ]);
      return true;
    case "smart-blur":
      emit(EffectOpcode.SmartBlur, [
        value("radius", 14),
        value("threshold", 0.12),
        value("mode"),
        value("blend", 100) / 100,
      ]);
      return true;
    case "vector-blur":
      emit(EffectOpcode.VectorBlur, [
        value("amount", 24),
        (value("angleBias") * Math.PI) / 180,
        value("map"),
        value("blend", 100) / 100,
      ]);
      return true;
    case "radial-fast-blur":
      emit(EffectOpcode.RadialFastBlur, [
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("amount", 18) / 100,
        value("mode"),
        value("blend", 100) / 100,
      ]);
      return true;
    case "high-pass":
      emit(EffectOpcode.HighPass, [
        value("radius", 8),
        value("contrast", 1),
        value("monochrome"),
        value("blend", 100) / 100,
      ]);
      return true;
    case "sharpen-edges":
      emit(EffectOpcode.SharpenEdges, [
        value("amount", 80) / 100,
        value("radius", 1.5),
        value("threshold", 0.03),
        value("blend", 100) / 100,
      ]);
      return true;
    case "compound-blur":
      emit(EffectOpcode.CompoundBlur, [
        value("maximumRadius", 36),
        value("map"),
        value("invert"),
        value("stretch", 1),
        value("blend", 100) / 100,
      ]);
      return true;
    default:
      return false;
  }
}
