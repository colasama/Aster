import { evaluateEffectParameter } from "../../../core/animation/timeline";
import type { Effect } from "../../../core/types";
import { EffectOpcode } from "../effect-opcodes";

export function compileRetroMediaEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const blend = () => value("blend", 100) / 100;
  switch (effect.type) {
    case "scanlines":
      emit(EffectOpcode.Scanlines, [
        value("spacing", 4),
        value("width", 1),
        value("intensity", 38) / 100,
        value("phase"),
        value("speed"),
        blend(),
      ]);
      return true;
    case "tape-dropout":
      emit(EffectOpcode.TapeDropout, [
        value("density", 18) / 100,
        value("length", 420),
        value("height", 3),
        value("speed", 14),
        value("seed", 1),
        blend(),
      ]);
      return true;
    case "head-switching":
      emit(EffectOpcode.HeadSwitching, [
        value("height", 12) / 100,
        value("amount", 72),
        value("speed", 0.45),
        value("softness", 24) / 100,
        blend(),
      ]);
      return true;
    case "compression-blocks":
      emit(EffectOpcode.CompressionBlocks, [
        value("blockSize", 16),
        value("quality", 42) / 100,
        value("chromaLoss", 55) / 100,
        value("ringing", 18) / 100,
        blend(),
      ]);
      return true;
    case "film-damage":
      emit(EffectOpcode.FilmDamage, [
        value("scratches", 24) / 100,
        value("dust", 18) / 100,
        value("flicker", 12) / 100,
        value("speed", 12),
        value("seed", 1),
        blend(),
      ]);
      return true;
    case "gate-weave":
      emit(EffectOpcode.GateWeave, [
        value("horizontal", 4),
        value("vertical", 3),
        (value("rotation", 0.08) * Math.PI) / 180,
        value("speed", 2),
        value("seed", 1),
        blend(),
      ]);
      return true;
    case "rgb-phosphor":
      emit(EffectOpcode.RgbPhosphor, [
        value("pitch", 3),
        value("maskStrength", 65) / 100,
        value("scanline", 20) / 100,
        value("colorBleed", 1.5),
        blend(),
      ]);
      return true;
    case "pixel-sort":
      emit(EffectOpcode.PixelSort, [
        value("threshold", 0.42),
        value("length", 72),
        (value("direction") * Math.PI) / 180,
        value("reverse"),
        blend(),
      ]);
      return true;
    default:
      return false;
  }
}
