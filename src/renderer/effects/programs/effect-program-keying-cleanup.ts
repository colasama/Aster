import { evaluateEffectParameter } from "../../../core/animation/timeline";
import type { Effect } from "../../../core/types";
import { EffectOpcode } from "../effect-opcodes";

export function compileKeyingCleanupEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const point = (key: string, fallback = 50) => value(key, fallback) / 100;
  const blend = () => value("blend", 100) / 100;
  switch (effect.type) {
    case "key-cleaner":
      emit(EffectOpcode.KeyCleaner, [
        value("radius", 2),
        value("strength", 75) / 100,
        value("contrast", 1.15),
        value("reduceChatter", 65) / 100,
        blend(),
      ]);
      return true;
    case "screen-matte":
      emit(EffectOpcode.ScreenMatte, [
        value("clipBlack", 0.04),
        value("clipWhite", 0.94),
        value("gamma", 1),
        value("shrinkGrow"),
        value("softness", 1),
        value("invert"),
        blend(),
      ]);
      return true;
    case "core-matte":
      emit(EffectOpcode.CoreMatte, [
        value("radius", 5),
        value("threshold", 0.72),
        value("softness", 0.08),
        value("density", 100) / 100,
        blend(),
      ]);
      return true;
    case "despot":
      emit(EffectOpcode.Despot, [
        value("radius", 3),
        value("threshold", 0.5),
        value("mode"),
        value("strength", 100) / 100,
        blend(),
      ]);
      return true;
    case "edge-extend":
      emit(EffectOpcode.EdgeExtend, [
        value("radius", 3),
        value("strength", 100) / 100,
        value("alphaThreshold", 0.18),
        blend(),
      ]);
      return true;
    case "edge-color-blend":
      emit(EffectOpcode.EdgeColorBlend, [
        value("radius", 4),
        value("amount", 70) / 100,
        value("preserveLuminance", 1),
        blend(),
      ]);
      return true;
    case "spill-killer":
      emit(EffectOpcode.SpillKiller, [
        ...colorChannels(value("screenColor", 0x00c878)),
        value("amount", 85) / 100,
        value("balance", 0.5),
        value("range", 0.12),
        value("preserveLuminance", 1),
        blend(),
      ]);
      return true;
    case "wire-removal":
      emit(EffectOpcode.WireRemoval, [
        point("startX", 40),
        point("startY", 20),
        point("endX", 60),
        point("endY", 80),
        value("width", 8),
        value("feather", 4),
        value("sampleOffset", 14),
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
