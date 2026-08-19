import { evaluateEffectParameter } from "../core/timeline";
import type { Effect } from "../core/types";
import { EffectOpcode } from "./effect-opcodes";

export function compileImmersiveVideoEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const degrees = (key: string, fallback = 0) => (value(key, fallback) * Math.PI) / 180;
  const blend = () => value("blend", 100) / 100;
  switch (effect.type) {
    case "vr-rotate-sphere":
      emit(EffectOpcode.VrRotateSphere, [
        degrees("yaw"),
        degrees("pitch"),
        degrees("roll"),
        blend(),
      ]);
      return true;
    case "vr-plane-to-sphere":
      emit(EffectOpcode.VrPlaneToSphere, [
        degrees("fieldOfView", 90),
        value("curvature", 100) / 100,
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        blend(),
      ]);
      return true;
    case "vr-chromatic-aberrations":
      emit(EffectOpcode.VrChromaticAberrations, [
        value("redShift", 0.32) / 360,
        value("blueShift", -0.32) / 360,
        value("polarFalloff", 1),
        blend(),
      ]);
      return true;
    case "vr-digital-glitch":
      emit(EffectOpcode.VrDigitalGlitch, [
        value("amount", 32),
        value("bandSize", 48),
        value("speed", 8),
        value("colorSplit", 6),
        value("seed", 1),
        blend(),
      ]);
      return true;
    case "vr-color-gradients":
      emit(EffectOpcode.VrColorGradients, [
        ...colorChannels(value("northColor", 0x315acb)),
        ...colorChannels(value("southColor", 0xff7a3d)),
        degrees("rotation"),
        value("intensity", 0.45),
        blend(),
      ]);
      return true;
    case "vr-glow":
      emit(EffectOpcode.VrGlow, [
        value("threshold", 0.72),
        value("radius", 18),
        value("intensity", 0.8),
        blend(),
      ]);
      return true;
    case "vr-blur":
      emit(EffectOpcode.VrBlur, [value("horizontal", 12), value("vertical", 8), blend()]);
      return true;
    case "vr-fractal-noise":
      emit(EffectOpcode.VrFractalNoise, [
        value("scale", 5),
        value("evolution", 0.35),
        value("contrast", 1.4),
        value("brightness"),
        value("opacity", 45) / 100,
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
