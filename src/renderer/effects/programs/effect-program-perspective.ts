import { evaluateEffectParameter } from "../../../core/animation/timeline";
import type { Effect } from "../../../core/types";
import { EffectOpcode } from "../effect-opcodes";

export function compilePerspectiveEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const degrees = (key: string, fallback = 0) => (value(key, fallback) * Math.PI) / 180;
  const color = (key: string, fallback: number) => colorChannels(value(key, fallback));
  switch (effect.type) {
    case "spherize":
      emit(EffectOpcode.Spherize, [
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("radius", 320),
        value("amount", 75) / 100,
      ]);
      return true;
    case "optics-compensation":
      emit(EffectOpcode.OpticsCompensation, [
        value("fieldOfView", 55) / 180,
        value("direction"),
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("scale", 100) / 100,
      ]);
      return true;
    case "bend-it":
      emit(EffectOpcode.BendIt, [
        value("startX", 50) / 100,
        value("startY", 20) / 100,
        value("endX", 50) / 100,
        value("endY", 80) / 100,
        value("bend", 120),
      ]);
      return true;
    case "cylinder":
      emit(EffectOpcode.Cylinder, [
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("radius", 480),
        degrees("rotation"),
        value("curvature", 100) / 100,
      ]);
      return true;
    case "sphere":
      emit(EffectOpcode.Sphere, [
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("radius", 420),
        degrees("rotation"),
        value("magnification", 100) / 100,
      ]);
      return true;
    case "mesh-warp":
      emit(EffectOpcode.MeshWarp, [
        value("horizontal", 32),
        value("vertical", 32),
        value("columns", 4),
        value("rows", 4),
        degrees("phase"),
        value("blend", 100) / 100,
      ]);
      return true;
    case "warp":
      emit(EffectOpcode.Warp, [
        value("style"),
        value("bend", 35) / 100,
        value("horizontal") / 100,
        value("vertical") / 100,
        degrees("axis"),
      ]);
      return true;
    case "page-turn":
      emit(EffectOpcode.PageTurn, [
        value("completion", 45) / 100,
        degrees("angle", -28),
        value("radius", 90),
        ...color("backColor", 0x596786),
        value("backOpacity", 85) / 100,
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
