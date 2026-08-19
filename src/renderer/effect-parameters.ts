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
