import { evaluateEffectParameter } from "../core/timeline";
import type { Effect } from "../core/types";
import { EffectOpcode } from "./effect-opcodes";

export function compileProfessionalColorEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const degrees = (key: string, fallback = 0) => (value(key, fallback) * Math.PI) / 180;
  switch (effect.type) {
    case "asc-cdl":
      emit(EffectOpcode.AscCdl, [
        value("slopeR", 1),
        value("slopeG", 1),
        value("slopeB", 1),
        value("offsetR"),
        value("offsetG"),
        value("offsetB"),
        value("powerR", 1),
        value("powerG", 1),
        value("powerB", 1),
        value("saturation", 1),
      ]);
      return true;
    case "rgb-lift-gamma-gain":
      emit(EffectOpcode.RgbLiftGammaGain, [
        value("liftR"),
        value("liftG"),
        value("liftB"),
        value("gammaR", 1),
        value("gammaG", 1),
        value("gammaB", 1),
        value("gainR", 1),
        value("gainG", 1),
        value("gainB", 1),
        value("master", 1),
      ]);
      return true;
    case "log-wheels":
      emit(EffectOpcode.LogWheels, [
        degrees("shadowHue", 220),
        value("shadowAmount"),
        degrees("midtoneHue", 30),
        value("midtoneAmount"),
        degrees("highlightHue", 45),
        value("highlightAmount"),
        value("shadowRange", 0.32),
        value("highlightRange", 0.68),
        value("saturation", 1),
      ]);
      return true;
    case "hsl-secondary":
      emit(EffectOpcode.HslSecondary, [
        degrees("hueCenter", 210),
        degrees("hueRange", 35),
        value("saturationMin", 0.15),
        value("saturationMax", 1),
        value("luminanceMin"),
        value("luminanceMax", 1),
        value("softness", 0.1),
        degrees("hueShift"),
        value("saturation", 1),
        value("lightness"),
        value("invert"),
      ]);
      return true;
    case "highlight-recovery":
      emit(EffectOpcode.HighlightRecovery, [
        value("threshold", 0.82),
        value("strength", 75) / 100,
        value("rolloff", 2.5),
        value("saturation", 65) / 100,
        value("blend", 100) / 100,
      ]);
      return true;
    case "gamut-compressor":
      emit(EffectOpcode.GamutCompressor, [
        value("threshold", 0.72),
        value("limit", 1),
        value("power", 2),
        value("preserveLuminance", 1),
        value("blend", 100) / 100,
      ]);
      return true;
    case "false-color":
      emit(EffectOpcode.FalseColor, [
        value("mode"),
        value("middleGray", 0.18),
        value("range", 6),
        value("opacity", 100) / 100,
      ]);
      return true;
    case "film-print-density":
      emit(EffectOpcode.FilmPrintDensity, [
        value("cyan"),
        value("magenta"),
        value("yellow"),
        value("density"),
        value("contrast", 1.08),
        value("softClip", 0.85),
        value("blend", 100) / 100,
      ]);
      return true;
    default:
      return false;
  }
}
