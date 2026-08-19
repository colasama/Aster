import { evaluateEffectParameter } from "../core/timeline";
import type { Effect } from "../core/types";
import { EffectOpcode } from "./effect-opcodes";

export function compileAdvancedStylizeEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const degrees = (key: string, fallback = 0) => (value(key, fallback) * Math.PI) / 180;
  const color = (key: string, fallback: number) => colorChannels(value(key, fallback));
  switch (effect.type) {
    case "color-halftone":
      emit(EffectOpcode.ColorHalftone, [
        value("radius", 8),
        degrees("redAngle", 15),
        degrees("greenAngle", 45),
        degrees("blueAngle", 75),
        value("monochrome"),
        value("blend", 100) / 100,
      ]);
      return true;
    case "glowing-edges":
      emit(EffectOpcode.GlowingEdges, [
        value("width", 1.5),
        value("threshold", 0.08),
        value("intensity", 2),
        ...color("color", 0x5bc8ff),
        value("invert"),
        value("blend", 100) / 100,
      ]);
      return true;
    case "texturize":
      emit(EffectOpcode.Texturize, [
        value("scale", 64),
        value("relief", 1.2),
        degrees("lightDirection", 135),
        value("contrast", 1),
        value("evolution"),
        value("blend", 100) / 100,
      ]);
      return true;
    case "tiles":
      emit(EffectOpcode.Tiles, [
        value("columns", 4),
        value("rows", 4),
        value("offsetX") / 100,
        value("offsetY") / 100,
        value("mirror", 1),
        value("grout", 2) / 100,
        ...color("groutColor", 0x111521),
      ]);
      return true;
    case "cc-threshold":
      emit(EffectOpcode.CcThreshold, [
        value("level", 0.5),
        value("softness", 0.02),
        value("channel"),
        value("invert"),
        value("blend", 100) / 100,
      ]);
      return true;
    case "cc-toner":
      emit(EffectOpcode.CcToner, [
        ...color("shadows", 0x102048),
        ...color("midtones", 0x8b5fc7),
        ...color("highlights", 0xffd6a0),
        value("balance"),
        value("blend", 100) / 100,
      ]);
      return true;
    case "cc-plastic":
      emit(EffectOpcode.CcPlastic, [
        value("softness", 3),
        value("height", 2),
        degrees("lightDirection", 315),
        value("specular", 1.5),
        ...color("color", 0x70a8ff),
        value("blend", 100) / 100,
      ]);
      return true;
    case "cc-blobbylize":
      emit(EffectOpcode.CcBlobbylize, [
        value("softness", 18),
        value("threshold", 0.48),
        value("cutAway", 0.08),
        degrees("lightDirection", 315),
        value("lightIntensity", 1.4),
        ...color("color", 0x6cb8ff),
        value("blend", 100) / 100,
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
