import type { Id, Layer } from "../types";
import type { LayerToggleField, Operation } from "./operation-types";

/** Visibility and solo are monitoring switches; every other locked-layer write requires unlock. */
export function canToggleLayer(layer: Pick<Layer, "locked">, field: LayerToggleField): boolean {
  return !layer.locked || field === "locked" || field === "visible" || field === "solo";
}

export function assertLayerOperationUnlocked(layer: Layer, operation: Operation): void {
  if (!layer.locked) return;
  if (operation.type === "toggleLayer" && canToggleLayer(layer, operation.field)) return;
  throw new Error("Layer is locked");
}

export function assertAdjustmentOperationSupported(layer: Layer, operation: Operation): void {
  if (layer.kind !== "adjustment") return;
  if (operation.type === "setBlendMode" && operation.blendMode !== "normal")
    throw new Error("Adjustment layers use replace semantics and require normal blend mode");
  const mappingOperations: readonly Operation["type"][] = [
    "setParent",
    "setLayerTimeMapping",
    "setLayerTimeRemap",
    "setProperty",
    "addKeyframe",
    "moveKeyframe",
    "updateKeyframe",
    "removeKeyframe",
    "easeLayer",
    "setExpression",
  ];
  if (mappingOperations.includes(operation.type))
    throw new Error(`Operation ${operation.type} has no visual meaning for adjustment layers`);
  if (
    operation.type === "toggleLayer" &&
    (operation.field === "threeDimensional" || operation.field === "audioEnabled")
  )
    throw new Error(`Adjustment layers cannot toggle ${operation.field}`);
  const sourceOperations: readonly Operation["type"][] = [
    "setLayerAudioGain",
    "setLayerAudioSettings",
    "setMaterial3d",
    "setLightSettings",
    "setLayerColor",
    "setSolidSettings",
    "setLayerSource",
    "setCameraSettings",
    "setSceneGenerator",
    "setClonerSettings",
    "setShapeSettings",
    "setShapeGraph",
    "setTextContent",
    "setTextStyle",
    "setTextAnimator",
  ];
  if (sourceOperations.includes(operation.type))
    throw new Error(`Operation ${operation.type} is not supported for adjustment layers`);
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : minimum;
}

export function validateParent(layers: Layer[], layerId: Id, parentId: Id | undefined): void {
  if (!parentId) return;
  if (parentId === layerId) throw new Error("A layer cannot parent itself");
  let current = layers.find((entry) => entry.id === parentId);
  if (!current) throw new Error("Parent layer does not exist");
  const visited = new Set<Id>();
  while (current?.parentId) {
    if (current.parentId === layerId) throw new Error("Parenting would create a cycle");
    if (visited.has(current.parentId)) throw new Error("Existing layer hierarchy contains a cycle");
    visited.add(current.parentId);
    current = layers.find((entry) => entry.id === current?.parentId);
  }
}
