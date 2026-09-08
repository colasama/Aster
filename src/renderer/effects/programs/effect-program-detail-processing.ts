import { evaluateEffectParameter } from "../../../core/animation/timeline";
import type { Effect } from "../../../core/types";
import { EffectOpcode } from "../effect-opcodes";

export function compileDetailProcessingEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const blend = () => value("blend", 100) / 100;
  switch (effect.type) {
    case "detail-preserving-upscale":
      emit(EffectOpcode.DetailPreservingUpscale, [
        value("scale", 2),
        value("detail", 60) / 100,
        value("noiseReduction", 0.025),
        blend(),
      ]);
      return true;
    case "reduce-interlace-flicker":
      emit(EffectOpcode.ReduceInterlaceFlicker, [
        value("radius", 1),
        value("strength", 65) / 100,
        blend(),
      ]);
      return true;
    case "deband":
      emit(EffectOpcode.Deband, [
        value("radius", 6),
        value("threshold", 0.018),
        value("dither", 35) / 100,
        blend(),
      ]);
      return true;
    case "denoise":
      emit(EffectOpcode.Denoise, [
        value("radius", 2),
        value("threshold", 0.08),
        value("strength", 75) / 100,
        value("preserveDetail", 35) / 100,
        blend(),
      ]);
      return true;
    case "clarity":
      emit(EffectOpcode.Clarity, [
        value("radius", 12),
        value("amount", 0.45),
        value("midtoneBias", 70) / 100,
        blend(),
      ]);
      return true;
    case "local-contrast":
      emit(EffectOpcode.LocalContrast, [
        value("radius", 36),
        value("amount", 0.6),
        value("threshold", 0.015),
        value("protectHighlights", 65) / 100,
        blend(),
      ]);
      return true;
    case "smart-sharpen":
      emit(EffectOpcode.SmartSharpen, [
        value("radius", 1.4),
        value("amount", 90) / 100,
        value("threshold", 0.025),
        value("remove"),
        (value("angle") * Math.PI) / 180,
        blend(),
      ]);
      return true;
    case "frequency-separation":
      emit(EffectOpcode.FrequencySeparation, [
        value("radius", 8),
        value("view", 2),
        value("detail", 1),
        blend(),
      ]);
      return true;
    default:
      return false;
  }
}
