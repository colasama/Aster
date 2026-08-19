import { evaluateEffectParameter } from "../core/timeline";
import type { Effect } from "../core/types";
import { EffectOpcode } from "./effect-opcodes";

export function compileNoiseGrainEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  switch (effect.type) {
    case "add-grain":
      emit(EffectOpcode.AddGrain, [
        value("intensity", 18) / 100,
        value("size", 1.4),
        value("softness", 0.35),
        value("colorAmount", 20) / 100,
        value("shadows", 100) / 100,
        value("midtones", 75) / 100,
        value("highlights", 45) / 100,
        value("speed", 1),
      ]);
      return true;
    case "dust-scratches":
      emit(EffectOpcode.DustScratches, [
        value("radius", 3),
        value("threshold", 0.12),
        value("softness", 0.04),
        value("blend", 100) / 100,
      ]);
      return true;
    case "median":
      emit(EffectOpcode.Median, [value("radius", 2), value("blend", 100) / 100]);
      return true;
    case "noise-alpha":
      emit(EffectOpcode.NoiseAlpha, [
        value("amount", 12) / 100,
        value("mode"),
        value("size", 1),
        value("speed", 1),
        value("clip", 1),
      ]);
      return true;
    case "noise-hls":
      emit(EffectOpcode.NoiseHls, [
        (value("hue", 8) * Math.PI) / 180,
        value("lightness", 8) / 100,
        value("saturation", 12) / 100,
        value("size", 1),
        value("phase"),
      ]);
      return true;
    case "noise-hls-auto":
      emit(EffectOpcode.NoiseHlsAuto, [
        value("amount", 12) / 100,
        value("colorAmount", 35) / 100,
        value("size", 1),
        value("speed", 2),
        value("seed", 1),
      ]);
      return true;
    case "remove-grain":
      emit(EffectOpcode.RemoveGrain, [
        value("radius", 2.5),
        value("threshold", 0.1),
        value("softness", 0.08),
        value("strength", 75) / 100,
      ]);
      return true;
    case "turbulent-noise":
      emit(EffectOpcode.TurbulentNoise, [
        value("type"),
        value("contrast", 1.4),
        value("brightness"),
        value("scale", 180),
        value("evolution"),
        value("opacity", 65) / 100,
        value("blendMode"),
      ]);
      return true;
    default:
      return false;
  }
}
