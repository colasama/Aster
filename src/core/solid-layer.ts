import { type Layer, type SolidSettings, setLayerSizeAndCenterAnchor } from "./types";

export const MAX_SOLID_DIMENSION = 30_000;

export function normalizeSolidSettings(settings: SolidSettings): SolidSettings {
  return {
    width: Math.round(clamp(settings.width, 1, MAX_SOLID_DIMENSION)),
    height: Math.round(clamp(settings.height, 1, MAX_SOLID_DIMENSION)),
    color: settings.color.map((channel) => clamp(channel, 0, 1)) as SolidSettings["color"],
  };
}

export function applySolidSettings(layer: Layer, settings: SolidSettings): void {
  if (layer.kind !== "solid") throw new Error("Solid settings require a solid layer");
  const normalized = normalizeSolidSettings(settings);
  const center = [layer.size[0] * 0.5, layer.size[1] * 0.5, 0];
  const wasCentered = layer.transform.anchor.every(
    (axis, index) => axis.mode === "static" && axis.value === center[index],
  );
  layer.solid = normalized;
  if (wasCentered) setLayerSizeAndCenterAnchor(layer, [normalized.width, normalized.height]);
  else layer.size = [normalized.width, normalized.height];
  layer.color = [...normalized.color];
}

export function solidRenderSize(layer: Layer): [number, number] {
  return layer.kind === "solid" && layer.solid
    ? [layer.solid.width, layer.solid.height]
    : layer.size;
}

export function solidRenderColor(layer: Layer): Layer["color"] {
  return layer.kind === "solid" && layer.solid ? layer.solid.color : layer.color;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}
