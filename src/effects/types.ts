export type EffectExecution = "fused-pixel" | "multi-pass" | "compute" | "temporal";
export type ParameterKind =
  | "number"
  | "angle"
  | "percent"
  | "color"
  | "choice"
  | "toggle"
  | "texture";

export interface EffectParameterDefinition {
  key: string;
  label: string;
  kind: ParameterKind;
  defaultValue: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: string[];
}

export interface EffectDefinition {
  type: string;
  name: string;
  category: string;
  description: string;
  execution: EffectExecution;
  parameters: EffectParameterDefinition[];
}
