import { evaluateEffectParameter } from "../core/timeline";
import type { Effect } from "../core/types";
import { EffectOpcode } from "./effect-opcodes";

export function compileSimulationEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const degrees = (key: string, fallback = 0) => (value(key, fallback) * Math.PI) / 180;
  const color = (key: string, fallback: number) => colorChannels(value(key, fallback));
  switch (effect.type) {
    case "bubbles":
      emit(EffectOpcode.Bubbles, [
        value("amount", 55),
        value("size", 14),
        value("speed", 85),
        value("wobble", 18),
        value("refraction", 0.65),
        ...color("color", 0xbcecff),
        value("seed", 1),
      ]);
      return true;
    case "drizzle":
      emit(EffectOpcode.Drizzle, [
        value("rate", 3),
        value("radius", 42),
        value("width", 3),
        value("speed", 120),
        value("disturbance", 0.7),
        ...color("color", 0x7fc8ff),
        value("seed", 1),
      ]);
      return true;
    case "hair":
      emit(EffectOpcode.Hair, [
        value("density", 32),
        value("length", 48),
        value("thickness", 1.5),
        degrees("direction", -90),
        value("wave", 18),
        value("speed", 2),
        ...color("color", 0xd5e7ff),
        value("opacity", 85) / 100,
      ]);
      return true;
    case "mr-mercury":
      emit(EffectOpcode.MrMercury, [
        value("producerX", 50) / 100,
        value("producerY", 45) / 100,
        value("blobSize", 54),
        value("velocity", 120),
        value("gravity", 80),
        value("viscosity", 1.3),
        ...color("color", 0xaed8ff),
        value("seed", 1),
      ]);
      return true;
    case "particle-systems-ii":
      emit(EffectOpcode.ParticleSystemsII, [
        value("producerX", 50) / 100,
        value("producerY", 50) / 100,
        value("birthRate", 4),
        value("longevity", 2.5),
        value("velocity", 180),
        degrees("direction", -90),
        degrees("spread", 45),
        value("gravity", 120),
        value("size", 5),
        ...color("color", 0x80c8ff),
        value("seed", 1),
      ]);
      return true;
    case "pixel-polly":
      emit(EffectOpcode.PixelPolly, [
        value("completion", 45) / 100,
        value("tileSize", 42),
        value("scatter", 360),
        value("gravity", 280),
        value("randomness", 1),
        value("seed", 1),
        value("fade", 20) / 100,
      ]);
      return true;
    case "scatterize":
      emit(EffectOpcode.Scatterize, [
        value("scatterX", 80),
        value("scatterY", 80),
        value("grain", 48),
        degrees("twist", 12),
        value("evolution"),
        value("blend", 100) / 100,
        value("seed", 1),
      ]);
      return true;
    case "wave-world":
      emit(EffectOpcode.WaveWorld, [
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("frequency", 7),
        value("speed", 2),
        value("damping", 1.8),
        value("height", 0.8),
        ...color("color", 0x4c9fe8),
        value("blend", 75) / 100,
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
