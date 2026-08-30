import type { TextAnimatorProperties } from "./text-animator-stack";
import type { TextSelector } from "./text-selectors";
import type { Animatable, Layer } from "./types";

export const TEXT_ANIMATOR_VECTOR_PROPERTY_FIELDS = [
  "anchorPoint",
  "position",
  "scale",
  "rotation",
  "fillColor",
  "strokeColor",
  "lineSpacing",
  "blur",
] as const satisfies readonly (keyof TextAnimatorProperties)[];

export const TEXT_ANIMATOR_SCALAR_PROPERTY_FIELDS = [
  "skew",
  "skewAxis",
  "opacity",
  "strokeWidth",
  "tracking",
  "lineAnchor",
  "characterOffset",
  "characterValue",
] as const satisfies readonly (keyof TextAnimatorProperties)[];

export const TEXT_RANGE_SELECTOR_ANIMATABLE_FIELDS = [
  "amount",
  "start",
  "end",
  "offset",
  "smoothness",
  "easeHigh",
  "easeLow",
] as const;

export const TEXT_WIGGLY_SELECTOR_ANIMATABLE_FIELDS = [
  "amount",
  "minimumAmount",
  "maximumAmount",
  "wigglesPerSecond",
  "correlation",
  "temporalPhase",
  "spatialPhase",
] as const;

export const TEXT_EXPRESSION_SELECTOR_ANIMATABLE_FIELDS = ["amount"] as const;

export type TextAnimatorVectorPropertyField = (typeof TEXT_ANIMATOR_VECTOR_PROPERTY_FIELDS)[number];
export type TextAnimatorScalarPropertyField = (typeof TEXT_ANIMATOR_SCALAR_PROPERTY_FIELDS)[number];
export type TextSelectorAnimatableField =
  | (typeof TEXT_RANGE_SELECTOR_ANIMATABLE_FIELDS)[number]
  | (typeof TEXT_WIGGLY_SELECTOR_ANIMATABLE_FIELDS)[number]
  | (typeof TEXT_EXPRESSION_SELECTOR_ANIMATABLE_FIELDS)[number];

export type TextAnimatorPropertyPath =
  | `textAnimator:${string}:property:${TextAnimatorScalarPropertyField}`
  | `textAnimator:${string}:property:${TextAnimatorVectorPropertyField}:${number}`
  | `textAnimator:${string}:selector:${string}:${TextSelectorAnimatableField}`;

export interface TextAnimatorPropertyEntry {
  component?: number;
  field: TextAnimatorScalarPropertyField | TextAnimatorVectorPropertyField;
  groupId: string;
  path: TextAnimatorPropertyPath;
  property: Animatable;
  source: "property";
}

export interface TextSelectorPropertyEntry {
  field: TextSelectorAnimatableField;
  groupId: string;
  path: TextAnimatorPropertyPath;
  property: Animatable;
  selectorId: string;
  source: "selector";
}

export type TextAnimatorTrackEntry = TextAnimatorPropertyEntry | TextSelectorPropertyEntry;

export function textAnimatorPropertyPath(
  groupId: string,
  field: TextAnimatorScalarPropertyField,
): TextAnimatorPropertyPath;
export function textAnimatorPropertyPath(
  groupId: string,
  field: TextAnimatorVectorPropertyField,
  component: number,
): TextAnimatorPropertyPath;
export function textAnimatorPropertyPath(
  groupId: string,
  field: TextAnimatorScalarPropertyField | TextAnimatorVectorPropertyField,
  component?: number,
): TextAnimatorPropertyPath {
  const suffix = component === undefined ? field : `${field}:${component}`;
  return `textAnimator:${encodeId(groupId)}:property:${suffix}` as TextAnimatorPropertyPath;
}

export function textSelectorPropertyPath(
  groupId: string,
  selectorId: string,
  field: TextSelectorAnimatableField,
): TextAnimatorPropertyPath {
  return `textAnimator:${encodeId(groupId)}:selector:${encodeId(selectorId)}:${field}`;
}

export function collectTextAnimatorTrackEntries(layer: Layer): TextAnimatorTrackEntry[] {
  const groups = layer.textAnimator?.groups ?? [];
  return groups.flatMap((group) => {
    const properties: TextAnimatorPropertyEntry[] = [];
    for (const field of TEXT_ANIMATOR_VECTOR_PROPERTY_FIELDS) {
      const value = group.properties[field];
      if (!Array.isArray(value)) continue;
      for (const [component, property] of value.entries())
        if (isAnimatable(property))
          properties.push({
            source: "property",
            groupId: group.id,
            field,
            component,
            path: textAnimatorPropertyPath(group.id, field, component),
            property,
          });
    }
    for (const field of TEXT_ANIMATOR_SCALAR_PROPERTY_FIELDS) {
      const property = group.properties[field];
      if (isAnimatable(property))
        properties.push({
          source: "property",
          groupId: group.id,
          field,
          path: textAnimatorPropertyPath(group.id, field),
          property,
        });
    }
    const selectors = group.selectors.flatMap((selector) =>
      selectorAnimatableFields(selector).map((field) => ({
        source: "selector" as const,
        groupId: group.id,
        selectorId: selector.id,
        field,
        path: textSelectorPropertyPath(group.id, selector.id, field),
        property: selectorProperty(selector, field),
      })),
    );
    return [...properties, ...selectors];
  });
}

export function isTextAnimatorPropertyPath(path: string): path is TextAnimatorPropertyPath {
  return parseTextAnimatorPropertyPath(path) !== undefined;
}

export function getTextAnimatorProperty(layer: Layer, path: TextAnimatorPropertyPath): Animatable {
  const target = resolveTarget(layer, path);
  if (!target) throw new Error("Text animator property does not exist");
  return target.property;
}

/** Replaces the owning object as well as the track so time-addressed evaluation caches invalidate. */
export function setTextAnimatorProperty(
  layer: Layer,
  path: TextAnimatorPropertyPath,
  value: Animatable,
): void {
  const parsed = parseTextAnimatorPropertyPath(path);
  const group = layer.textAnimator?.groups.find((candidate) => candidate.id === parsed?.groupId);
  if (!parsed || !group) throw new Error("Text animator property does not exist");
  if (parsed.source === "property") {
    const current = group.properties[parsed.field];
    if (parsed.component === undefined) {
      if (!isAnimatable(current)) throw new Error("Text animator property does not exist");
      group.properties = { ...group.properties, [parsed.field]: value };
      return;
    }
    if (!Array.isArray(current) || !isAnimatable(current[parsed.component]))
      throw new Error("Text animator property does not exist");
    const next = [...current];
    next[parsed.component] = value;
    group.properties = { ...group.properties, [parsed.field]: next } as TextAnimatorProperties;
    return;
  }
  const index = group.selectors.findIndex((candidate) => candidate.id === parsed.selectorId);
  const selector = group.selectors[index];
  if (!selector || !selectorAnimatableFields(selector).includes(parsed.field))
    throw new Error("Text selector property does not exist");
  group.selectors[index] = { ...selector, [parsed.field]: value } as TextSelector;
}

interface ParsedPropertyPath {
  component?: number;
  field: TextAnimatorScalarPropertyField | TextAnimatorVectorPropertyField;
  groupId: string;
  source: "property";
}

interface ParsedSelectorPath {
  field: TextSelectorAnimatableField;
  groupId: string;
  selectorId: string;
  source: "selector";
}

function parseTextAnimatorPropertyPath(
  path: string,
): ParsedPropertyPath | ParsedSelectorPath | undefined {
  const parts = path.split(":");
  if (parts[0] !== "textAnimator") return undefined;
  const groupId = decodeId(parts[1]);
  if (groupId === undefined) return undefined;
  if (parts[2] === "property") {
    const field = parts[3];
    if (isScalarField(field) && parts.length === 4) return { source: "property", groupId, field };
    const component = Number(parts[4]);
    if (
      isVectorField(field) &&
      parts.length === 5 &&
      Number.isInteger(component) &&
      component >= 0 &&
      component < vectorLength(field)
    )
      return { source: "property", groupId, field, component };
    return undefined;
  }
  if (parts[2] !== "selector" || parts.length !== 5) return undefined;
  const selectorId = decodeId(parts[3]);
  const field = parts[4];
  return selectorId !== undefined && isSelectorField(field)
    ? { source: "selector", groupId, selectorId, field }
    : undefined;
}

function resolveTarget(
  layer: Layer,
  path: TextAnimatorPropertyPath,
): TextAnimatorTrackEntry | undefined {
  return collectTextAnimatorTrackEntries(layer).find((entry) => entry.path === path);
}

function selectorAnimatableFields(selector: TextSelector): readonly TextSelectorAnimatableField[] {
  if (selector.kind === "range") return TEXT_RANGE_SELECTOR_ANIMATABLE_FIELDS;
  if (selector.kind === "wiggly") return TEXT_WIGGLY_SELECTOR_ANIMATABLE_FIELDS;
  return TEXT_EXPRESSION_SELECTOR_ANIMATABLE_FIELDS;
}

function selectorProperty(selector: TextSelector, field: TextSelectorAnimatableField): Animatable {
  const value = (selector as unknown as Record<string, unknown>)[field];
  if (!isAnimatable(value)) throw new Error("Text selector property does not exist");
  return value;
}

function isScalarField(value: string | undefined): value is TextAnimatorScalarPropertyField {
  return TEXT_ANIMATOR_SCALAR_PROPERTY_FIELDS.includes(value as TextAnimatorScalarPropertyField);
}

function isVectorField(value: string | undefined): value is TextAnimatorVectorPropertyField {
  return TEXT_ANIMATOR_VECTOR_PROPERTY_FIELDS.includes(value as TextAnimatorVectorPropertyField);
}

function isSelectorField(value: string | undefined): value is TextSelectorAnimatableField {
  return (
    TEXT_RANGE_SELECTOR_ANIMATABLE_FIELDS.includes(
      value as (typeof TEXT_RANGE_SELECTOR_ANIMATABLE_FIELDS)[number],
    ) ||
    TEXT_WIGGLY_SELECTOR_ANIMATABLE_FIELDS.includes(
      value as (typeof TEXT_WIGGLY_SELECTOR_ANIMATABLE_FIELDS)[number],
    ) ||
    TEXT_EXPRESSION_SELECTOR_ANIMATABLE_FIELDS.includes(
      value as (typeof TEXT_EXPRESSION_SELECTOR_ANIMATABLE_FIELDS)[number],
    )
  );
}

function vectorLength(field: TextAnimatorVectorPropertyField): number {
  if (field === "fillColor" || field === "strokeColor") return 4;
  if (field === "lineSpacing" || field === "blur") return 2;
  return 3;
}

function isAnimatable(value: unknown): value is Animatable {
  return Boolean(value && typeof value === "object" && "mode" in value);
}

function encodeId(value: string): string {
  return encodeURIComponent(value).split(".").join("%2E");
}

function decodeId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
