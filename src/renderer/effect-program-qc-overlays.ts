import { evaluateEffectParameter } from "../core/timeline";
import type { Effect } from "../core/types";
import { EffectOpcode } from "./effect-opcodes";

export function compileQcOverlayEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const color = (key: string, fallback: number) => colorChannels(value(key, fallback));
  const opacity = () => value("opacity", 100) / 100;
  const blend = () => value("blend", 100) / 100;
  switch (effect.type) {
    case "zebra-overlay":
      emit(EffectOpcode.ZebraOverlay, [
        value("threshold", 0.82),
        value("spacing", 16),
        (value("angle", 45) * Math.PI) / 180,
        ...color("color", 0xffd52a),
        opacity(),
        blend(),
      ]);
      return true;
    case "gamut-warning":
      emit(EffectOpcode.GamutWarning, [
        value("gamut"),
        value("limit", 1),
        value("chromaLimit", 0.82),
        ...color("color", 0xff00ff),
        opacity(),
        blend(),
      ]);
      return true;
    case "focus-peaking":
      emit(EffectOpcode.FocusPeaking, [
        value("radius", 1.5),
        value("threshold", 0.08),
        ...color("color", 0x00e5ff),
        opacity(),
        blend(),
      ]);
      return true;
    case "alpha-boundary":
      emit(EffectOpcode.AlphaBoundary, [
        value("radius", 2),
        value("threshold", 0.05),
        ...color("color", 0x39ff88),
        opacity(),
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
