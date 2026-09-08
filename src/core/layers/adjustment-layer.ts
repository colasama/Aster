import { createTransform, type Layer, type Transform } from "../types";

const SOURCE_FIELDS = [
  "sourceId",
  "text",
  "sourceCompositionId",
  "material",
  "light",
  "camera",
  "mesh",
  "generator",
  "cloner",
  "shape",
  "shapeGraph",
  "textStyle",
  "textAnimator",
  "audioEnabled",
  "audio",
  "expressions",
  "timeOffset",
  "timeStretch",
  "timeRemap",
] as const satisfies readonly (keyof Layer)[];

interface AdjustmentCompositionBounds {
  width: number;
  height: number;
}

export function createCanonicalAdjustmentTransform(
  composition: AdjustmentCompositionBounds,
): Transform {
  return createTransform([composition.width / 2, composition.height / 2, 0]);
}

/** Enforces the strict MVP contract for a composition-wide adjustment layer. */
export function assertAdjustmentLayerInvariants(
  layer: Pick<Layer, keyof Layer>,
  composition: AdjustmentCompositionBounds,
  path = "layer",
): void {
  if (layer.kind !== "adjustment") return;
  if (layer.parentId !== undefined)
    throw new Error(`${path}.parentId is not supported for adjustment layers`);
  if (layer.threeDimensional)
    throw new Error(`${path}.threeDimensional must be false for adjustment layers`);
  if (layer.blendMode !== "normal")
    throw new Error(`${path}.blendMode must be normal for adjustment layers`);
  if (layer.color.some((channel) => channel !== 0))
    throw new Error(`${path}.color must be transparent for adjustment layers`);
  if (layer.size[0] !== composition.width || layer.size[1] !== composition.height)
    throw new Error(`${path}.size must match its composition for adjustment layers`);
  if (!isCanonicalTransform(layer.transform, createCanonicalAdjustmentTransform(composition)))
    throw new Error(`${path}.transform must be canonical for adjustment layers`);
  for (const field of SOURCE_FIELDS) {
    if (layer[field] !== undefined)
      throw new Error(`${path}.${field} is not supported for adjustment layers`);
  }
}

function isCanonicalTransform(actual: Transform, expected: Transform): boolean {
  const actualProperties = [
    ...actual.position,
    ...actual.rotation,
    ...actual.scale,
    ...actual.anchor,
    actual.opacity,
  ];
  const expectedProperties = [
    ...expected.position,
    ...expected.rotation,
    ...expected.scale,
    ...expected.anchor,
    expected.opacity,
  ];
  return actualProperties.every(
    (property, index) =>
      property.mode === "static" &&
      expectedProperties[index]?.mode === "static" &&
      property.value === expectedProperties[index].value,
  );
}
