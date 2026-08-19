import { visibleLayersAtTime } from "../core/scene-evaluation";
import type { Composition, Layer } from "../core/types";

export interface PostProcessParameters {
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  glow: number;
  glowThreshold: number;
  blur: number;
  chromatic: number;
  vignette: number;
  grain: number;
  gamma: number;
  fade: number;
  pivot: number;
  lift: number;
  gain: number;
}

export const defaultPostProcessParameters = (): PostProcessParameters => ({
  exposure: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  tint: 0,
  glow: 0,
  glowThreshold: 0.8,
  blur: 0,
  chromatic: 0,
  vignette: 0,
  grain: 0,
  gamma: 1,
  fade: 0,
  pivot: 0.18,
  lift: 0,
  gain: 1,
});

export function collectPostProcessParameters(
  composition: Composition,
  time = 0,
  layers: Layer[] = visibleLayersAtTime(composition, time),
): PostProcessParameters {
  const output = defaultPostProcessParameters();
  for (const layer of layers) {
    for (const effect of layer.effects) {
      if (!effect.enabled) continue;
      const value = (key: string, fallback = 0) => effect.parameters[key] ?? fallback;
      switch (effect.type) {
        case "exposure":
          output.exposure += value("exposure");
          output.gamma *= value("gamma", 1);
          break;
        case "brightness-contrast":
          output.exposure += value("brightness") * 1.5;
          output.contrast *= value("contrast", 1);
          break;
        case "color-matrix":
          output.exposure += Math.log2(Math.max(0.001, value("gain", 1)));
          output.contrast *= value("contrast", 1);
          output.saturation *= value("saturation", 1);
          break;
        case "vibrance":
          output.saturation *= value("saturation", 1) + value("vibrance") * 0.5;
          break;
        case "gaussian-blur":
        case "kawase-blur":
          output.blur = Math.max(output.blur, value("radius"));
          break;
        case "glow":
        case "bloom":
          output.glow += value("intensity");
          output.glowThreshold = Math.min(output.glowThreshold, value("threshold", 0.8));
          output.blur = Math.max(output.blur, value("radius") * 0.08);
          break;
        case "chromatic":
          output.chromatic += value("amount");
          break;
        case "looks-color-lab":
          output.temperature += value("temperature");
          output.tint += value("tint");
          output.exposure += value("exposure");
          output.contrast *= value("contrast", 1);
          output.pivot = value("pivot", 0.42);
          output.saturation *= value("saturation", 1) + value("vibrance") * 0.35;
          output.lift += value("lift");
          output.gamma *= value("gamma", 1);
          output.gain *= value("gain", 1);
          output.vignette += value("vignette");
          output.grain += value("grain");
          output.glow += value("bloom");
          output.fade += value("fade");
          break;
        case "film-emulation": {
          const strength = value("strength", 1);
          const stock = value("stock");
          output.grain += value("grain") * strength;
          output.glow += value("halation") * strength;
          output.contrast *= 1 + 0.08 * strength;
          if (stock > 0.5 && stock < 1.5) {
            output.temperature += 0.25 * strength;
            output.tint += 0.06 * strength;
            output.saturation *= 1 + 0.05 * strength;
          } else if (stock > 1.5 && stock < 2.5) {
            output.contrast *= 1 + 0.1 * strength;
            output.saturation *= 1 + 0.18 * strength;
          } else if (stock > 2.5) {
            output.contrast *= 1 + 0.18 * strength;
            output.saturation *= Math.max(0, 1 - 0.35 * strength);
          }
          break;
        }
      }
    }
  }
  output.exposure = clamp(output.exposure, -12, 12);
  output.contrast = clamp(output.contrast, 0, 4);
  output.saturation = clamp(output.saturation, 0, 4);
  output.temperature = clamp(output.temperature, -2, 2);
  output.tint = clamp(output.tint, -2, 2);
  output.glow = clamp(output.glow, 0, 12);
  output.blur = clamp(output.blur, 0, 64);
  output.chromatic = clamp(output.chromatic, 0, 100);
  output.vignette = clamp(output.vignette, 0, 2);
  output.grain = clamp(output.grain, 0, 1);
  output.gamma = clamp(output.gamma, 0.1, 10);
  output.fade = clamp(output.fade, 0, 1);
  output.pivot = clamp(output.pivot, 0, 1);
  output.lift = clamp(output.lift, -2, 2);
  output.gain = clamp(output.gain, 0, 8);
  return output;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
