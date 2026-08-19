import { evaluateEffectParameter } from "../core/timeline";
import type { Effect } from "../core/types";
import { EffectOpcode } from "./effect-opcodes";

export function compileAdvancedTransitionEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const degrees = (key: string, fallback = 0) => (value(key, fallback) * Math.PI) / 180;
  const color = (key: string, fallback: number) => colorChannels(value(key, fallback));
  switch (effect.type) {
    case "clock-wipe":
      emit(EffectOpcode.ClockWipe, [
        value("completion", 50) / 100,
        degrees("startAngle", -90),
        degrees("feather", 3),
        value("counterClockwise"),
      ]);
      return true;
    case "grid-wipe":
      emit(EffectOpcode.GridWipe, [
        value("completion", 50) / 100,
        value("columns", 12),
        value("rows", 7),
        value("border", 8) / 100,
        value("softness", 12) / 100,
        value("seed", 1),
      ]);
      return true;
    case "jaws":
      emit(EffectOpcode.Jaws, [
        value("completion", 50) / 100,
        degrees("direction"),
        value("teeth", 12),
        value("toothDepth", 35) / 100,
        value("feather", 3),
        value("invert"),
      ]);
      return true;
    case "light-wipe":
      emit(EffectOpcode.LightWipe, [
        value("completion", 50) / 100,
        degrees("direction"),
        value("width", 80),
        value("intensity", 2),
        ...color("color", 0xa8dcff),
        value("feather", 12),
      ]);
      return true;
    case "line-sweep":
      emit(EffectOpcode.LineSweep, [
        value("completion", 50) / 100,
        degrees("direction"),
        value("width", 12),
        value("feather", 8),
        value("invert"),
      ]);
      return true;
    case "scale-wipe":
      emit(EffectOpcode.ScaleWipe, [
        value("completion", 50) / 100,
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        degrees("rotation"),
        value("feather", 12),
      ]);
      return true;
    case "twister":
      emit(EffectOpcode.Twister, [
        value("completion", 50) / 100,
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("twists", 1.5),
        value("radius", 640),
        value("feather", 32),
      ]);
      return true;
    case "card-wipe":
      emit(EffectOpcode.CardWipe, [
        value("completion", 50) / 100,
        value("columns", 12),
        value("rows", 7),
        value("randomness", 75) / 100,
        value("seed", 1),
        ...color("backColor", 0x29324d),
        value("backOpacity", 90) / 100,
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
