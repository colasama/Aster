import { evaluateEffectParameter } from "../../../core/animation/timeline";
import type { Effect } from "../../../core/types";
import { EffectOpcode } from "../effect-opcodes";

export function compileLightingEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const degrees = (key: string, fallback = 0) => (value(key, fallback) * Math.PI) / 180;
  const color = (key: string, fallback: number) => colorChannels(value(key, fallback));
  switch (effect.type) {
    case "light-rays":
      emit(EffectOpcode.LightRays, [
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("length", 240),
        value("threshold", 0.55),
        value("intensity", 1.5),
        ...color("color", 0xb8e7ff),
        value("blend", 100) / 100,
      ]);
      return true;
    case "spotlight":
      emit(EffectOpcode.Spotlight, [
        value("sourceX", 50) / 100,
        value("sourceY", 15) / 100,
        value("targetX", 50) / 100,
        value("targetY", 65) / 100,
        degrees("coneAngle", 38),
        degrees("feather", 12),
        value("falloff", 1.5),
        value("intensity", 1.4),
        ...color("color", 0xffe8bc),
      ]);
      return true;
    case "light-leak":
      emit(EffectOpcode.LightLeak, [
        degrees("angle", 18),
        value("width", 0.32),
        value("softness", 0.45),
        value("intensity", 1.2),
        ...color("colorA", 0xff4e36),
        ...color("colorB", 0xffc65a),
        value("speed", 0.35),
        value("seed", 1),
        value("blend", 75) / 100,
      ]);
      return true;
    case "anamorphic-flare":
      emit(EffectOpcode.AnamorphicFlare, [
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        degrees("angle"),
        value("length", 640),
        value("width", 6),
        value("intensity", 2),
        value("ghosts", 0.55),
        ...color("color", 0x78bfff),
      ]);
      return true;
    case "volumetric-fog":
      emit(EffectOpcode.VolumetricFog, [
        value("density", 45) / 100,
        value("scale", 280),
        value("height", 1.3),
        value("speedX", 18),
        value("speedY", -4),
        ...color("color", 0x7894c7),
        value("blend", 75) / 100,
      ]);
      return true;
    case "caustics":
      emit(EffectOpcode.Caustics, [
        value("scale", 90),
        value("speed", 1.2),
        value("complexity", 3),
        value("intensity", 1.4),
        value("depth", 0.8),
        ...color("color", 0x79d8ff),
        value("blend", 70) / 100,
      ]);
      return true;
    case "god-rays":
      emit(EffectOpcode.GodRays, [
        value("centerX", 50) / 100,
        value("centerY", 20) / 100,
        value("density", 0.75),
        value("decay", 0.92),
        value("weight", 0.28),
        value("threshold", 0.6),
        value("exposure", 1.2),
        ...color("color", 0xffe7bb),
      ]);
      return true;
    case "laser":
      emit(EffectOpcode.Laser, [
        value("startX", 20) / 100,
        value("startY", 50) / 100,
        value("endX", 80) / 100,
        value("endY", 50) / 100,
        value("core", 2),
        value("glow", 18),
        value("intensity", 2.5),
        value("pulse", 0.35),
        value("speed", 3),
        ...color("color", 0x50d4ff),
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
