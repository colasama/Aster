import { defaultPostProcessParameters, type PostProcessParameters } from "./effect-parameters";

export function buildPostProcessUniforms(
  width: number,
  height: number,
  time: number,
  effects: PostProcessParameters = defaultPostProcessParameters(),
  operationCount = 0,
  linearOutput = false,
  blurMaxLod = 0,
  maskedGlow = false,
): Float32Array {
  return new Float32Array([
    width,
    height,
    time,
    effects.exposure,
    effects.contrast,
    effects.saturation,
    effects.temperature,
    effects.tint,
    effects.glow,
    effects.glowThreshold,
    effects.blur,
    effects.chromatic,
    effects.vignette,
    effects.grain,
    effects.gamma,
    effects.fade,
    operationCount,
    Number(linearOutput),
    blurMaxLod,
    Number(maskedGlow),
    effects.pivot,
    effects.lift,
    effects.gain,
    0,
  ]);
}
