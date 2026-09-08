import { evaluateAnimatable, evaluateEffectParameter } from "../../../core/animation/timeline";
import type { Effect } from "../../../core/types";
import { EffectOpcode } from "../effect-opcodes";

export function compileDrawGeneratorEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): boolean {
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const point = (key: string, fallback = 50) => value(key, fallback) / 100;
  const degrees = (key: string, fallback = 0) => (value(key, fallback) * Math.PI) / 180;
  const color = (key: string, fallback: number) => colorChannels(value(key, fallback));
  const opacity = () => value("opacity", 100) / 100;
  const blend = () => value("blend", 100) / 100;
  switch (effect.type) {
    case "multi-stop-gradient": {
      // Packed 24-bit colors are exact in f32; five stops fit one existing operation.
      const stops = [
        [0, gradientColor(effect, "color1", time, 0x38cddd)],
        [point("position2", 25), gradientColor(effect, "color2", time, 0xd9f3f2)],
        [point("position3", 50), gradientColor(effect, "color3", time, 0xe757a4)],
        [point("position4", 80), gradientColor(effect, "color4", time, 0x0784d5)],
        [1, gradientColor(effect, "color5", time, 0x021a2b)],
      ]
        .map(([position, packed]) => [
          Math.min(1, Math.max(0, position)),
          Math.min(0xffffff, Math.max(0, Math.round(packed))),
        ])
        .sort((a, b) => a[0] - b[0]);
      emit(EffectOpcode.MultiStopGradient, [
        point("startX", 0),
        point("startY"),
        point("endX", 100),
        point("endY"),
        ...stops.map((stop) => stop[1]),
        ...stops.slice(1, 4).map((stop) => stop[0]),
        value("interpolation"),
        blend(),
        value("mapping"),
      ]);
      return true;
    }
    case "ellipse":
      emit(EffectOpcode.Ellipse, [
        point("centerX"),
        point("centerY"),
        value("width", 480),
        value("height", 280),
        degrees("rotation"),
        value("thickness", 12),
        value("feather", 2),
        value("mode"),
        ...color("color", 0x65bdff),
        opacity(),
        blend(),
      ]);
      return true;
    case "stroke":
      emit(EffectOpcode.Stroke, [
        point("startX", 20),
        point("startY", 65),
        point("controlX"),
        point("controlY", 20),
        point("endX", 80),
        point("endY", 65),
        value("width", 14),
        value("feather", 3),
        value("start") / 100,
        value("end", 100) / 100,
        ...color("color", 0x77d8ff),
        opacity(),
        blend(),
      ]);
      return true;
    case "vegas":
      emit(EffectOpcode.Vegas, [
        value("edgeRadius", 2),
        value("segmentLength", 48),
        degrees("rotation"),
        value("width", 6),
        ...color("color", 0xff4fd8),
        opacity(),
        blend(),
      ]);
      return true;
    case "scribble":
      emit(EffectOpcode.Scribble, [
        value("spacing", 32),
        degrees("angle", -25),
        value("width", 3),
        value("wiggle", 12),
        value("evolution", 0.5),
        ...color("color", 0xf8f1d8),
        opacity(),
        blend(),
      ]);
      return true;
    case "write-on":
      emit(EffectOpcode.WriteOn, [
        point("startX", 20),
        point("startY"),
        point("endX", 80),
        point("endY"),
        value("progress", 60) / 100,
        value("width", 18),
        value("feather", 4),
        ...color("color", 0xffc857),
        opacity(),
        blend(),
      ]);
      return true;
    case "eyedropper-fill":
      emit(EffectOpcode.EyedropperFill, [
        point("sampleX"),
        point("sampleY"),
        value("tolerance", 0.18),
        value("softness", 0.08),
        ...color("color", 0x5fd7ff),
        opacity(),
        blend(),
      ]);
      return true;
    case "paint-bucket":
      emit(EffectOpcode.PaintBucket, [
        point("seedX"),
        point("seedY"),
        value("tolerance", 0.2),
        value("softness", 0.08),
        value("radius", 720),
        ...color("color", 0xff6f5f),
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

function gradientColor(effect: Effect, key: string, time: number, fallback: number): number {
  const keyframes = effect.parameterKeyframes?.[key];
  if (!keyframes?.length) return effect.parameters[key] ?? fallback;
  // Interpolate channels, not packed integers, to avoid green flashes during color animation.
  return [16, 8, 0].reduce((packed, shift) => {
    const channel = evaluateAnimatable(
      {
        mode: "animated",
        keyframes: keyframes.map((frame) => ({
          ...frame,
          value: (Math.max(0, Math.min(0xffffff, Math.round(frame.value))) >> shift) & 255,
        })),
      },
      time,
    );
    return packed + (Math.max(0, Math.min(255, Math.round(channel))) << shift);
  }, 0);
}
