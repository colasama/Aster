import { evaluateEffectParameter } from "../../../core/animation/timeline";
import type { Effect } from "../../../core/types";
import { EffectOpcode } from "../effect-opcodes";

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
    case "fast-bokeh": {
      const blades = [3, 4, 5, 6, 7, 8, 64][Math.round(value("irisShape", 5))] ?? 6;
      const samples = [16, 24, 32][Math.round(value("quality", 1))] ?? 24;
      emit(EffectOpcode.FastBokeh, [
        value("radius", 40),
        value("depthSource"),
        value("invertDepth") > 0.5 ? -1 : 1,
        value("focus", 0.5),
        Math.max(value("focusRange", 0.12), 0.001),
        value("focusCenterX", 50) / 100,
        value("focusCenterY", 50) / 100,
        blades,
        (value("irisRotation") * Math.PI) / 180,
        value("irisRoundness") / 100,
        value("irisAspect", 1),
        (value("highlightGain") / 100) * 8,
        value("highlightThreshold", 0.85),
        value("highlightSaturation", 100) / 100,
        samples,
      ]);
      return true;
    }
    default:
      return false;
  }
}
