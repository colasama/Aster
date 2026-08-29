import {
  MAX_TEXT_ANIMATOR_GROUPS,
  type TextAnimatorColorProperty,
  type TextAnimatorGroup,
  type TextAnimatorProperties,
} from "./text-animator-stack";
import type {
  TextExpressionSelector,
  TextRangeSelector,
  TextSelector,
  TextWigglySelector,
} from "./text-selectors";
import { type Animatable, createId, type Keyframe, staticValue } from "./types";

export const MAX_TEXT_SELECTORS_PER_GROUP = 32;

export function createDefaultRangeSelector(index = 0): TextRangeSelector {
  return {
    id: createId(),
    name: `Range Selector ${index + 1}`,
    kind: "range",
    enabled: true,
    mode: "add",
    amount: staticValue(100),
    basedOn: "characters",
    units: "percentage",
    start: staticValue(0),
    end: staticValue(100),
    offset: staticValue(0),
    shape: "square",
    smoothness: staticValue(100),
    easeHigh: staticValue(0),
    easeLow: staticValue(0),
    randomizeOrder: false,
    randomSeed: 0,
  };
}

export function createDefaultWigglySelector(index = 0): TextWigglySelector {
  return {
    id: createId(),
    name: `Wiggly Selector ${index + 1}`,
    kind: "wiggly",
    enabled: true,
    mode: "add",
    amount: staticValue(100),
    basedOn: "characters",
    minimumAmount: staticValue(-100),
    maximumAmount: staticValue(100),
    wigglesPerSecond: staticValue(2),
    correlation: staticValue(0),
    temporalPhase: staticValue(0),
    spatialPhase: staticValue(1),
    randomSeed: 0,
  };
}

export function createDefaultExpressionSelector(index = 0): TextExpressionSelector {
  return {
    id: createId(),
    name: `Expression Selector ${index + 1}`,
    kind: "expression",
    enabled: true,
    mode: "add",
    amount: staticValue(100),
    basedOn: "characters",
    expression: "selectorValue * textIndex / textTotal",
  };
}

export function createDefaultTextAnimatorGroup(index = 0): TextAnimatorGroup {
  return {
    id: createId(),
    name: `Animator ${index + 1}`,
    enabled: true,
    randomSeed: 0,
    selectors: [createDefaultRangeSelector()],
    properties: { position: [staticValue(0), staticValue(0), staticValue(0)] },
  };
}

/** Creates an independent selector copy with fresh persistent and keyframe IDs. */
export function duplicateTextSelector(selector: TextSelector): TextSelector {
  return cloneSelector(selector, true);
}

/** Creates an independent animator copy with fresh IDs throughout the nested stack. */
export function duplicateTextAnimatorGroup(group: TextAnimatorGroup): TextAnimatorGroup {
  return {
    ...group,
    id: createId(),
    name: copyName(group.name),
    selectors: group.selectors.map((selector) => cloneSelector(selector, false)),
    properties: cloneProperties(group.properties),
  };
}

export function normalizeTextAnimatorGroups(
  groups: readonly TextAnimatorGroup[],
): TextAnimatorGroup[] {
  const ids = new Set<string>();
  return groups.slice(0, MAX_TEXT_ANIMATOR_GROUPS).map((group, index) => {
    const id = uniqueId(group.id, ids);
    return {
      id,
      name: boundedName(group.name, `Animator ${index + 1}`),
      enabled: Boolean(group.enabled),
      randomSeed: integer(group.randomSeed, -2_147_483_648, 2_147_483_647, 0),
      selectors: normalizeSelectors(group.selectors),
      properties: normalizeProperties(group.properties),
    };
  });
}

function normalizeSelectors(selectors: readonly TextSelector[]): TextSelector[] {
  const ids = new Set<string>();
  return selectors.slice(0, MAX_TEXT_SELECTORS_PER_GROUP).map((selector, index) => {
    const common = {
      id: uniqueId(selector.id, ids),
      name: boundedName(selector.name, `${selectorName(selector.kind)} ${index + 1}`),
      enabled: Boolean(selector.enabled),
      mode: oneOf(
        selector.mode,
        ["add", "subtract", "intersect", "min", "max", "difference"],
        "add",
      ),
      amount: normalizeTrack(selector.amount, -100, 100, 100),
      basedOn: oneOf(
        selector.basedOn,
        ["characters", "charactersExcludingSpaces", "words", "lines"],
        "characters",
      ),
    } as const;
    if (selector.kind === "range")
      return {
        ...common,
        kind: "range",
        units: oneOf(selector.units, ["percentage", "index"], "percentage"),
        start: normalizeTrack(selector.start, -1_000_000, 1_000_000, 0),
        end: normalizeTrack(selector.end, -1_000_000, 1_000_000, 100),
        offset: normalizeTrack(selector.offset, -1_000_000, 1_000_000, 0),
        shape: oneOf(
          selector.shape,
          ["square", "rampUp", "rampDown", "triangle", "round", "smooth"],
          "square",
        ),
        smoothness: normalizeTrack(selector.smoothness, 0, 100, 100),
        easeHigh: normalizeTrack(selector.easeHigh, -100, 100, 0),
        easeLow: normalizeTrack(selector.easeLow, -100, 100, 0),
        randomizeOrder: Boolean(selector.randomizeOrder),
        randomSeed: integer(selector.randomSeed, -2_147_483_648, 2_147_483_647, 0),
      };
    if (selector.kind === "wiggly")
      return {
        ...common,
        kind: "wiggly",
        minimumAmount: normalizeTrack(selector.minimumAmount, -100, 100, -100),
        maximumAmount: normalizeTrack(selector.maximumAmount, -100, 100, 100),
        wigglesPerSecond: normalizeTrack(selector.wigglesPerSecond, 0, 100, 2),
        correlation: normalizeTrack(selector.correlation, 0, 100, 0),
        temporalPhase: normalizeTrack(selector.temporalPhase, -1_000_000, 1_000_000, 0),
        spatialPhase: normalizeTrack(selector.spatialPhase, -1_000_000, 1_000_000, 1),
        randomSeed: integer(selector.randomSeed, -2_147_483_648, 2_147_483_647, 0),
      };
    return {
      ...common,
      kind: "expression",
      expression: String(selector.expression ?? "").slice(0, 2_048),
    };
  });
}

function cloneSelector(selector: TextSelector, rename: boolean): TextSelector {
  const common = {
    id: createId(),
    name: rename ? copyName(selector.name) : selector.name,
    enabled: selector.enabled,
    mode: selector.mode,
    amount: cloneTrack(selector.amount),
    basedOn: selector.basedOn,
  };
  if (selector.kind === "range")
    return {
      ...common,
      kind: "range",
      units: selector.units,
      start: cloneTrack(selector.start),
      end: cloneTrack(selector.end),
      offset: cloneTrack(selector.offset),
      shape: selector.shape,
      smoothness: cloneTrack(selector.smoothness),
      easeHigh: cloneTrack(selector.easeHigh),
      easeLow: cloneTrack(selector.easeLow),
      randomizeOrder: selector.randomizeOrder,
      randomSeed: selector.randomSeed,
    };
  if (selector.kind === "wiggly")
    return {
      ...common,
      kind: "wiggly",
      minimumAmount: cloneTrack(selector.minimumAmount),
      maximumAmount: cloneTrack(selector.maximumAmount),
      wigglesPerSecond: cloneTrack(selector.wigglesPerSecond),
      correlation: cloneTrack(selector.correlation),
      temporalPhase: cloneTrack(selector.temporalPhase),
      spatialPhase: cloneTrack(selector.spatialPhase),
      randomSeed: selector.randomSeed,
    };
  return { ...common, kind: "expression", expression: selector.expression };
}

function cloneProperties(properties: TextAnimatorProperties): TextAnimatorProperties {
  return {
    ...(properties.anchorPoint ? { anchorPoint: cloneVector3(properties.anchorPoint) } : {}),
    ...(properties.position ? { position: cloneVector3(properties.position) } : {}),
    ...(properties.scale ? { scale: cloneVector3(properties.scale) } : {}),
    ...(properties.rotation ? { rotation: cloneVector3(properties.rotation) } : {}),
    ...(properties.skew ? { skew: cloneTrack(properties.skew) } : {}),
    ...(properties.skewAxis ? { skewAxis: cloneTrack(properties.skewAxis) } : {}),
    ...(properties.opacity ? { opacity: cloneTrack(properties.opacity) } : {}),
    ...(properties.fillColor ? { fillColor: cloneColor(properties.fillColor) } : {}),
    ...(properties.strokeColor ? { strokeColor: cloneColor(properties.strokeColor) } : {}),
    ...(properties.strokeWidth ? { strokeWidth: cloneTrack(properties.strokeWidth) } : {}),
    ...(properties.tracking ? { tracking: cloneTrack(properties.tracking) } : {}),
    ...(properties.lineAnchor ? { lineAnchor: cloneTrack(properties.lineAnchor) } : {}),
    ...(properties.lineSpacing ? { lineSpacing: cloneVector2(properties.lineSpacing) } : {}),
    ...(properties.characterOffset
      ? { characterOffset: cloneTrack(properties.characterOffset) }
      : {}),
    ...(properties.characterValue ? { characterValue: cloneTrack(properties.characterValue) } : {}),
    ...(properties.characterRange ? { characterRange: properties.characterRange } : {}),
    ...(properties.blur ? { blur: cloneVector2(properties.blur) } : {}),
  };
}

function cloneTrack(value: Animatable): Animatable {
  if (value.mode === "static") return { mode: "static", value: value.value };
  return {
    mode: "animated",
    keyframes: value.keyframes.map((keyframe) => ({
      ...keyframe,
      id: createId(),
      ...(keyframe.easing
        ? { easing: [...keyframe.easing] as [number, number, number, number] }
        : {}),
    })),
  };
}

function cloneVector2(value: readonly Animatable[]): [Animatable, Animatable] {
  return [cloneTrack(value[0] as Animatable), cloneTrack(value[1] as Animatable)];
}

function cloneVector3(value: readonly Animatable[]): [Animatable, Animatable, Animatable] {
  return [
    cloneTrack(value[0] as Animatable),
    cloneTrack(value[1] as Animatable),
    cloneTrack(value[2] as Animatable),
  ];
}

function cloneColor(value: TextAnimatorColorProperty): TextAnimatorColorProperty {
  return value.map(cloneTrack) as TextAnimatorColorProperty;
}

function copyName(value: string): string {
  const suffix = " Copy";
  return `${value.slice(0, 128 - suffix.length)}${suffix}`;
}

function selectorName(kind: TextSelector["kind"]): string {
  if (kind === "range") return "Range Selector";
  if (kind === "wiggly") return "Wiggly Selector";
  return "Expression Selector";
}

function normalizeProperties(properties: TextAnimatorProperties): TextAnimatorProperties {
  return {
    ...optionalVector(properties.position, 3, -8192, 8192, "position"),
    ...optionalVector(properties.scale, 3, -10_000, 10_000, "scale", 100),
    ...optionalVector(properties.rotation, 3, -36_000, 36_000, "rotation"),
    ...(properties.anchorPoint
      ? { anchorPoint: vector3(properties.anchorPoint, -8192, 8192, 0) }
      : {}),
    ...(properties.skew === undefined
      ? {}
      : { skew: normalizeTrack(properties.skew, -360, 360, 0) }),
    ...(properties.skewAxis === undefined
      ? {}
      : { skewAxis: normalizeTrack(properties.skewAxis, -360, 360, 0) }),
    ...(properties.opacity === undefined
      ? {}
      : { opacity: normalizeTrack(properties.opacity, 0, 100, 100) }),
    ...(properties.fillColor ? { fillColor: color(properties.fillColor) } : {}),
    ...(properties.strokeColor ? { strokeColor: color(properties.strokeColor) } : {}),
    ...(properties.strokeWidth === undefined
      ? {}
      : { strokeWidth: normalizeTrack(properties.strokeWidth, -4096, 4096, 0) }),
    ...(properties.tracking === undefined
      ? {}
      : { tracking: normalizeTrack(properties.tracking, -10_000, 10_000, 0) }),
    ...(properties.lineAnchor === undefined
      ? {}
      : { lineAnchor: normalizeTrack(properties.lineAnchor, 0, 100, 50) }),
    ...(properties.lineSpacing
      ? { lineSpacing: vector2(properties.lineSpacing, -8192, 8192, 0) }
      : {}),
    ...(properties.characterOffset === undefined
      ? {}
      : {
          characterOffset: normalizeTrack(properties.characterOffset, -0x10ffff, 0x10ffff, 0),
        }),
    ...(properties.characterValue === undefined
      ? {}
      : { characterValue: normalizeTrack(properties.characterValue, 0, 0x10ffff, 0xfffd) }),
    ...(properties.characterOffset === undefined && properties.characterValue === undefined
      ? {}
      : {
          characterRange: oneOf(
            properties.characterRange,
            ["preserveCaseAndDigits", "fullUnicode"],
            "preserveCaseAndDigits",
          ),
        }),
    ...(properties.blur ? { blur: vector2(properties.blur, 0, 4096, 0) } : {}),
  };
}

function optionalVector(
  value: readonly Animatable[] | undefined,
  length: number,
  minimum: number,
  maximum: number,
  name?: "position" | "scale" | "rotation",
  fallback = 0,
): Partial<TextAnimatorProperties> {
  return value && name ? { [name]: vector(value, length, minimum, maximum, fallback) } : {};
}

function vector(
  value: readonly unknown[],
  length: number,
  minimum: number,
  maximum: number,
  fallback: number,
): Animatable[] {
  return Array.from({ length }, (_, index) =>
    normalizeTrack(value[index], minimum, maximum, fallback),
  );
}

function vector2(
  value: readonly unknown[],
  minimum: number,
  maximum: number,
  fallback: number,
): [Animatable, Animatable] {
  return vector(value, 2, minimum, maximum, fallback) as [Animatable, Animatable];
}

function vector3(
  value: readonly unknown[],
  minimum: number,
  maximum: number,
  fallback: number,
): [Animatable, Animatable, Animatable] {
  return vector(value, 3, minimum, maximum, fallback) as [Animatable, Animatable, Animatable];
}

function color(value: TextAnimatorColorProperty): TextAnimatorColorProperty {
  return vector(value, 4, 0, 1, 0) as TextAnimatorColorProperty;
}

function uniqueId(value: string, ids: Set<string>): string {
  const base = String(value || createId()).slice(0, 256);
  let candidate = base;
  let suffix = 2;
  while (ids.has(candidate)) candidate = `${base.slice(0, 240)}-${suffix++}`;
  ids.add(candidate);
  return candidate;
}

function boundedName(value: string | undefined, fallback: string): string {
  return (
    String(value ?? "")
      .trim()
      .slice(0, 128) || fallback
  );
}

function normalizeTrack(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): Animatable {
  if (typeof value === "number") return staticValue(bounded(value, minimum, maximum, fallback));
  if (!value || typeof value !== "object") return staticValue(fallback);
  const property = value as Partial<Animatable> & { keyframes?: unknown };
  if (property.mode === "static")
    return staticValue(bounded(property.value, minimum, maximum, fallback));
  if (property.mode !== "animated" || !Array.isArray(property.keyframes))
    return staticValue(fallback);
  const ids = new Set<string>();
  const keyframes = property.keyframes
    .slice(0, 10_000)
    .flatMap((value, index) => normalizeKeyframe(value, index, ids, minimum, maximum))
    .sort((left, right) => left.time - right.time)
    .filter((keyframe, index, values) => index === 0 || keyframe.time > values[index - 1].time);
  return { mode: "animated", keyframes };
}

function normalizeKeyframe(
  value: unknown,
  index: number,
  ids: Set<string>,
  minimum: number,
  maximum: number,
): Keyframe[] {
  if (!value || typeof value !== "object") return [];
  const keyframe = value as Partial<Keyframe>;
  if (!Number.isFinite(keyframe.time) || !Number.isFinite(keyframe.value)) return [];
  const id = uniqueId(String(keyframe.id || `keyframe-${index + 1}`), ids);
  const interpolation = oneOf(keyframe.interpolation, ["linear", "step", "bezier"], "linear");
  return [
    {
      id,
      time: Math.max(0, keyframe.time as number),
      value: bounded(keyframe.value, minimum, maximum, 0),
      interpolation,
      ...(validTuple4(keyframe.easing) ? { easing: keyframe.easing } : {}),
      ...(Number.isFinite(keyframe.spatialIn) ? { spatialIn: keyframe.spatialIn } : {}),
      ...(Number.isFinite(keyframe.spatialOut) ? { spatialOut: keyframe.spatialOut } : {}),
    },
  ];
}

function validTuple4(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function oneOf<const Value extends string>(
  value: unknown,
  values: readonly Value[],
  fallback: Value,
): Value {
  return values.includes(value as Value) ? (value as Value) : fallback;
}

function bounded(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Math.min(
    maximum,
    Math.max(minimum, typeof value === "number" && Number.isFinite(value) ? value : fallback),
  );
}

function integer(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Math.round(bounded(value, minimum, maximum, fallback));
}
