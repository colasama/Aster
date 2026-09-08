import { MAX_TEXT_SELECTORS_PER_GROUP } from "../../animation/text-animator-groups";

import { MAX_TEXT_ANIMATOR_GROUPS } from "../../animation/text-animator-stack";

import {
  requireObject,
  requireString,
  validateBoundedAnimatable,
  validateInteger,
  validateUniqueBoundedId,
} from "./values";

export function validateTextAnimator(value: unknown, path: string): void {
  const animator = requireObject(value, path);
  if (typeof animator.enabled !== "boolean") throw new Error(`${path}.enabled must be a boolean`);
  if (!Array.isArray(animator.groups) || animator.groups.length > MAX_TEXT_ANIMATOR_GROUPS)
    throw new Error(`${path}.groups must be a bounded array`);
  const groupIds = new Set<string>();
  for (const [groupIndex, groupValue] of animator.groups.entries()) {
    const groupPath = `${path}.groups[${groupIndex}]`;
    const group = requireObject(groupValue, groupPath);
    validateUniqueBoundedId(group.id, `${groupPath}.id`, groupIds);
    const name = requireString(group.name, `${groupPath}.name`);
    if (!name.trim() || name.length > 128) throw new Error(`${groupPath}.name is invalid`);
    if (typeof group.enabled !== "boolean")
      throw new Error(`${groupPath}.enabled must be a boolean`);
    validateInteger(group.randomSeed, `${groupPath}.randomSeed`, [-2_147_483_648, 2_147_483_647]);
    validateTextAnimatorProperties(group.properties, `${groupPath}.properties`);
    if (!Array.isArray(group.selectors) || group.selectors.length > MAX_TEXT_SELECTORS_PER_GROUP)
      throw new Error(`${groupPath}.selectors must be a bounded array`);
    const selectorIds = new Set<string>();
    for (const [selectorIndex, selectorValue] of group.selectors.entries())
      validateTextSelector(selectorValue, `${groupPath}.selectors[${selectorIndex}]`, selectorIds);
  }
}

function validateTextSelector(value: unknown, path: string, ids: Set<string>): void {
  const selector = requireObject(value, path);
  validateUniqueBoundedId(selector.id, `${path}.id`, ids);
  const name = requireString(selector.name, `${path}.name`);
  if (!name.trim() || name.length > 128) throw new Error(`${path}.name is invalid`);
  if (typeof selector.enabled !== "boolean") throw new Error(`${path}.enabled must be a boolean`);
  if (!["add", "subtract", "intersect", "min", "max", "difference"].includes(String(selector.mode)))
    throw new Error(`${path}.mode is unsupported`);
  if (
    !["characters", "charactersExcludingSpaces", "words", "lines"].includes(
      String(selector.basedOn),
    )
  )
    throw new Error(`${path}.basedOn is unsupported`);
  validateBoundedAnimatable(selector.amount, `${path}.amount`, [-100, 100]);
  if (selector.kind === "range") {
    if (!["percentage", "index"].includes(String(selector.units)))
      throw new Error(`${path}.units is unsupported`);
    if (
      !["square", "rampUp", "rampDown", "triangle", "round", "smooth"].includes(
        String(selector.shape),
      )
    )
      throw new Error(`${path}.shape is unsupported`);
    for (const field of ["start", "end", "offset"] as const)
      validateBoundedAnimatable(selector[field], `${path}.${field}`, [-1_000_000, 1_000_000]);
    validateBoundedAnimatable(selector.smoothness, `${path}.smoothness`, [0, 100]);
    validateBoundedAnimatable(selector.easeHigh, `${path}.easeHigh`, [-100, 100]);
    validateBoundedAnimatable(selector.easeLow, `${path}.easeLow`, [-100, 100]);
    if (typeof selector.randomizeOrder !== "boolean")
      throw new Error(`${path}.randomizeOrder must be a boolean`);
    validateInteger(selector.randomSeed, `${path}.randomSeed`, [-2_147_483_648, 2_147_483_647]);
    return;
  }
  if (selector.kind === "wiggly") {
    validateBoundedAnimatable(selector.minimumAmount, `${path}.minimumAmount`, [-100, 100]);
    validateBoundedAnimatable(selector.maximumAmount, `${path}.maximumAmount`, [-100, 100]);
    validateBoundedAnimatable(selector.wigglesPerSecond, `${path}.wigglesPerSecond`, [0, 100]);
    validateBoundedAnimatable(selector.correlation, `${path}.correlation`, [0, 100]);
    validateBoundedAnimatable(
      selector.temporalPhase,
      `${path}.temporalPhase`,
      [-1_000_000, 1_000_000],
    );
    validateBoundedAnimatable(
      selector.spatialPhase,
      `${path}.spatialPhase`,
      [-1_000_000, 1_000_000],
    );
    validateInteger(selector.randomSeed, `${path}.randomSeed`, [-2_147_483_648, 2_147_483_647]);
    return;
  }
  if (selector.kind !== "expression") throw new Error(`${path}.kind is unsupported`);
  const expression = requireString(selector.expression, `${path}.expression`);
  if (!expression.trim() || expression.length > 2_048)
    throw new Error(`${path}.expression must contain at most 2048 characters`);
}

function validateTextAnimatorProperties(value: unknown, path: string): void {
  const properties = requireObject(value, path);
  for (const [field, length, bounds] of [
    ["anchorPoint", 3, [-8192, 8192]],
    ["position", 3, [-8192, 8192]],
    ["scale", 3, [-10_000, 10_000]],
    ["rotation", 3, [-36_000, 36_000]],
    ["fillColor", 4, [0, 1]],
    ["strokeColor", 4, [0, 1]],
    ["lineSpacing", 2, [-8192, 8192]],
    ["blur", 2, [0, 4096]],
  ] as const) {
    if (properties[field] === undefined) continue;
    const vector = properties[field];
    if (!Array.isArray(vector) || vector.length !== length)
      throw new Error(`${path}.${field} must contain ${length} animated values`);
    for (const [index, property] of vector.entries())
      validateBoundedAnimatable(property, `${path}.${field}[${index}]`, bounds);
  }
  for (const [field, bounds] of [
    ["skew", [-360, 360]],
    ["skewAxis", [-360, 360]],
    ["opacity", [0, 100]],
    ["strokeWidth", [-4096, 4096]],
    ["tracking", [-10_000, 10_000]],
    ["lineAnchor", [0, 100]],
    ["characterOffset", [-0x10ffff, 0x10ffff]],
    ["characterValue", [0, 0x10ffff]],
  ] as const)
    if (properties[field] !== undefined)
      validateBoundedAnimatable(properties[field], `${path}.${field}`, bounds);
  const hasCharacterReplacement =
    properties.characterOffset !== undefined || properties.characterValue !== undefined;
  if (hasCharacterReplacement) {
    if (!["preserveCaseAndDigits", "fullUnicode"].includes(String(properties.characterRange)))
      throw new Error(`${path}.characterRange is unsupported`);
  } else if (properties.characterRange !== undefined) {
    throw new Error(`${path}.characterRange requires Character Offset or Character Value`);
  }
}
