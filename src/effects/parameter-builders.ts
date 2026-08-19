import type { EffectParameterDefinition } from "./types";

export const number = (
  key: string,
  label: string,
  defaultValue: number,
  min: number,
  max: number,
  step = 1,
  unit = "",
): EffectParameterDefinition => ({
  key,
  label,
  kind: "number",
  defaultValue,
  min,
  max,
  step,
  unit,
});

export const percent = (key: string, label: string, defaultValue: number) => ({
  ...number(key, label, defaultValue, 0, 100, 1, "%"),
  kind: "percent" as const,
});

export const angle = (key: string, label: string, defaultValue: number) => ({
  ...number(key, label, defaultValue, -360, 360, 1, "°"),
  kind: "angle" as const,
});

export const toggle = (
  key: string,
  label: string,
  defaultValue = 1,
): EffectParameterDefinition => ({
  key,
  label,
  kind: "toggle",
  defaultValue,
  min: 0,
  max: 1,
  step: 1,
});

export const choice = (
  key: string,
  label: string,
  options: string[],
  defaultValue = 0,
): EffectParameterDefinition => ({
  key,
  label,
  kind: "choice",
  defaultValue,
  options,
  min: 0,
  max: options.length - 1,
  step: 1,
});

export const color = (
  key: string,
  label: string,
  defaultValue: number,
): EffectParameterDefinition => ({
  key,
  label,
  kind: "color",
  defaultValue,
});
