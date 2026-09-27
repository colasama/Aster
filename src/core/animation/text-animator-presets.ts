import { type Animatable, createId, type Keyframe, staticValue } from "../types";
import { normalizeTextAnimatorGroups } from "./text-animator-groups";
import {
  MAX_TEXT_ANIMATOR_GROUPS,
  type TextAnimatorGroup,
  type TextAnimatorProperties,
} from "./text-animator-stack";
import type {
  TextExpressionSelector,
  TextRangeSelector,
  TextSelector,
  TextSelectorBasedOn,
  TextSelectorMode,
  TextWigglySelector,
} from "./text-selectors";

/**
 * A text animation preset is a bundle of animator groups whose keyframes are
 * stored relative to the preset start (time 0). Applying a preset shifts every
 * keyframe to the current layer time and regenerates all persistent IDs so the
 * same preset can be applied repeatedly without detaching existing tracks.
 */
export interface TextAnimatorPreset {
  id: string;
  name: string;
  category: "entrance" | "emphasis" | "layout";
  builtIn: boolean;
  groups: TextAnimatorGroup[];
}

export const TEXT_ANIMATOR_PRESET_STORAGE_KEY = "aster.textAnimatorPresets.v1";

interface StoredPresetFile {
  version: 1;
  presets: { id: string; name: string; groups: TextAnimatorGroup[] }[];
}

type Vec3 = [Animatable, Animatable, Animatable];
type Vec2 = [Animatable, Animatable];

const vec3 = (x: number, y: number, z = 0): Vec3 => [
  staticValue(x),
  staticValue(y),
  staticValue(z),
];
const vec2 = (x: number, y: number): Vec2 => [staticValue(x), staticValue(y)];
const rgba = (
  r: number,
  g: number,
  b: number,
  a = 1,
): [Animatable, Animatable, Animatable, Animatable] => [
  staticValue(r),
  staticValue(g),
  staticValue(b),
  staticValue(a),
];

/** Creates an animated scalar track; easing applies to every outgoing keyframe. */
function track(
  keys: readonly (readonly [number, number])[],
  easing: [number, number, number, number] = [0.33, 1, 0.68, 1],
): Animatable {
  const keyframes: Keyframe[] = keys.map(([time, value], index) => ({
    id: createId(),
    time,
    value,
    interpolation: "bezier",
    ...(index < keys.length - 1 ? { easing } : {}),
  }));
  return { mode: "animated", keyframes };
}

interface SelectorOptions {
  basedOn?: TextSelectorBasedOn;
  mode?: TextSelectorMode;
  name?: string;
}

function rangeSelector(
  start: Animatable,
  options: SelectorOptions & {
    end?: Animatable;
    offset?: Animatable;
    shape?: TextRangeSelector["shape"];
    smoothness?: number;
    easeHigh?: number;
    easeLow?: number;
    randomizeOrder?: boolean;
    randomSeed?: number;
    units?: TextRangeSelector["units"];
  } = {},
): TextRangeSelector {
  return {
    id: createId(),
    name: options.name ?? "Range Selector",
    kind: "range",
    enabled: true,
    mode: options.mode ?? "add",
    amount: staticValue(100),
    basedOn: options.basedOn ?? "characters",
    units: options.units ?? "percentage",
    start,
    end: options.end ?? staticValue(100),
    offset: options.offset ?? staticValue(0),
    shape: options.shape ?? "square",
    smoothness: staticValue(options.smoothness ?? 100),
    easeHigh: staticValue(options.easeHigh ?? 0),
    easeLow: staticValue(options.easeLow ?? 0),
    randomizeOrder: options.randomizeOrder ?? false,
    randomSeed: options.randomSeed ?? 0,
  };
}

function wigglySelector(
  options: SelectorOptions & {
    minimumAmount?: number;
    maximumAmount?: number;
    wigglesPerSecond?: number;
    correlation?: number;
    spatialPhase?: number;
    randomSeed?: number;
  } = {},
): TextWigglySelector {
  return {
    id: createId(),
    name: options.name ?? "Wiggly Selector",
    kind: "wiggly",
    enabled: true,
    mode: options.mode ?? "add",
    amount: staticValue(100),
    basedOn: options.basedOn ?? "characters",
    minimumAmount: staticValue(options.minimumAmount ?? -100),
    maximumAmount: staticValue(options.maximumAmount ?? 100),
    wigglesPerSecond: staticValue(options.wigglesPerSecond ?? 8),
    correlation: staticValue(options.correlation ?? 0),
    temporalPhase: staticValue(0),
    spatialPhase: staticValue(1),
    randomSeed: options.randomSeed ?? 0,
  };
}

function expressionSelector(
  expression: string,
  options: SelectorOptions = {},
): TextExpressionSelector {
  return {
    id: createId(),
    name: options.name ?? "Expression Selector",
    kind: "expression",
    enabled: true,
    mode: options.mode ?? "add",
    amount: staticValue(100),
    basedOn: options.basedOn ?? "characters",
    expression,
  };
}

function group(
  name: string,
  selectors: TextSelector[],
  properties: TextAnimatorProperties,
): TextAnimatorGroup {
  return { id: createId(), name, enabled: true, randomSeed: 0, selectors, properties };
}

/**
 * Forward sweep: the animated Start edge walks the selection window past each
 * unit so displaced units settle one by one in reading order.
 */
function sweep(duration: number, options: Parameters<typeof rangeSelector>[1] = {}) {
  return rangeSelector(
    track([
      [0, 0],
      [duration, 100],
    ]),
    {
      smoothness: 80,
      easeLow: -30,
      easeHigh: 50,
      ...options,
    },
  );
}

/** Reverse sweep: the End edge contracts so trailing units settle first. */
function reverseSweep(duration: number, options: Parameters<typeof rangeSelector>[1] = {}) {
  return rangeSelector(staticValue(0), {
    end: track([
      [0, 100],
      [duration, 0],
    ]),
    smoothness: 80,
    easeLow: -30,
    easeHigh: 50,
    ...options,
  });
}

/**
 * Deterministic per-unit hash in [0, 1). The expression host exposes sin,
 * floor and %, so this is the classic sine-hash used by shader code.
 */
function hash(expressionSeed: number, coefficient: number): string {
  return `(abs(sin(textIndex * ${coefficient} + ${expressionSeed}) * 43758.5453) % 1)`;
}

/**
 * Per-unit delayed progress in [0, 1]: 0 before the unit's delay elapses, then
 * eases to 1 over `duration` seconds. delayExpression is evaluated in seconds
 * and may use textIndex/textTotal.
 */
function progress(delayExpression: string, duration: number): string {
  return `clamp(linear(time, ${delayExpression}, ${delayExpression} + ${duration}, 0, 1), 0, 1)`;
}

function preset(
  id: string,
  name: string,
  category: TextAnimatorPreset["category"],
  groups: TextAnimatorGroup[],
): TextAnimatorPreset {
  return { id, name, category, builtIn: true, groups };
}

const STAGGER = "(textIndex - 1) * 0.06";
const HALFWAY = "((textTotal + 1) / 2)";

export const BUILT_IN_TEXT_PRESETS: readonly TextAnimatorPreset[] = [
  preset("builtin.fade-in", "Fade In", "entrance", [
    group("Fade In", [sweep(0.8)], { opacity: staticValue(0) }),
  ]),
  preset("builtin.rise-up", "Rise Up", "entrance", [
    group("Rise Up", [sweep(0.9)], {
      position: vec3(0, 60, 0),
      opacity: staticValue(0),
    }),
  ]),
  preset("builtin.drop-in", "Drop In", "entrance", [
    group("Drop In", [sweep(0.9)], {
      position: vec3(0, -60, 0),
      opacity: staticValue(0),
    }),
  ]),
  preset("builtin.scale-in", "Scale In", "entrance", [
    group("Scale In", [sweep(0.7)], { scale: vec3(0, 0, 100), opacity: staticValue(0) }),
  ]),
  preset("builtin.pop-in", "Pop In", "entrance", [
    group(
      "Pop In",
      [
        expressionSelector(
          `clamp(1 - ${progress(STAGGER, 0.45)} - sin(${progress(STAGGER, 0.45)} * pi) * 0.6, -1, 1) * 100`,
        ),
      ],
      { scale: vec3(0, 0, 100) },
    ),
  ]),
  preset("builtin.stretch-in", "Stretch In", "entrance", [
    group("Stretch In", [sweep(0.8)], { scale: vec3(35, 220, 100), opacity: staticValue(0) }),
  ]),
  preset("builtin.rotate-in", "Rotate In", "entrance", [
    group("Rotate In", [sweep(0.9)], {
      rotation: vec3(0, 0, -70),
      opacity: staticValue(0),
    }),
  ]),
  preset("builtin.flip-in", "Flip In", "entrance", [
    group("Flip In", [sweep(0.9)], { rotation: vec3(-90, 0, 0), opacity: staticValue(0) }),
  ]),
  preset("builtin.blur-in", "Blur In", "entrance", [
    group("Blur In", [sweep(0.8)], { blur: vec2(16, 16), opacity: staticValue(0) }),
  ]),
  preset("builtin.typewriter", "Typewriter", "entrance", [
    group("Typewriter", [sweep(1.6, { smoothness: 100, easeLow: 0, easeHigh: 0 })], {
      opacity: staticValue(0),
    }),
  ]),
  preset("builtin.tracking-in", "Tracking In", "entrance", [
    group("Tracking In", [sweep(1)], { tracking: staticValue(60), opacity: staticValue(0) }),
  ]),
  preset("builtin.random-fade", "Random Fade", "entrance", [
    group("Random Fade", [sweep(1.2, { randomizeOrder: true, randomSeed: 7 })], {
      opacity: staticValue(0),
    }),
  ]),
  preset("builtin.center-out", "Center Out", "entrance", [
    group(
      "Center Out",
      [expressionSelector(`(1 - ${progress(`abs(textIndex - ${HALFWAY}) * 0.12`, 0.45)}) * 100`)],
      { opacity: staticValue(0), position: vec3(0, 24, 0) },
    ),
  ]),
  preset("builtin.edges-in", "Edges In", "entrance", [
    group(
      "Edges In",
      [
        expressionSelector(
          `(1 - ${progress("min(textIndex - 1, textTotal - textIndex) * 0.12", 0.45)}) * 100`,
        ),
      ],
      { opacity: staticValue(0), position: vec3(0, 24, 0) },
    ),
  ]),
  preset("builtin.scatter-in", "Scatter In", "entrance", [
    group(
      "Scatter X",
      [
        expressionSelector(
          `cos(floor(${hash(5, 12.9898)} * 8) * pi / 4) * (1 - ${progress(`${hash(1.3, 78.233)} * 0.4`, 0.5)}) * 100`,
        ),
      ],
      { position: vec3(160, 0, 0) },
    ),
    group(
      "Scatter Y",
      [
        expressionSelector(
          `sin(floor(${hash(5, 12.9898)} * 8) * pi / 4) * (1 - ${progress(`${hash(1.3, 78.233)} * 0.4`, 0.5)}) * 100`,
        ),
      ],
      { position: vec3(0, 160, 0) },
    ),
    group(
      "Scatter Spin",
      [
        expressionSelector(
          `(${hash(0.9, 3.7)} * 2 - 1) * (1 - ${progress(`${hash(1.3, 78.233)} * 0.4`, 0.5)}) * 100`,
        ),
      ],
      { rotation: vec3(0, 0, 360) },
    ),
    group(
      "Scatter Fade",
      [expressionSelector(`(1 - ${progress(`${hash(1.3, 78.233)} * 0.4`, 0.5)}) * 100`)],
      { opacity: staticValue(0) },
    ),
  ]),
  preset("builtin.word-rise", "Word Rise", "entrance", [
    group("Word Rise", [sweep(0.8, { basedOn: "words" })], {
      position: vec3(0, 40, 0),
      opacity: staticValue(0),
    }),
  ]),
  preset("builtin.line-cascade", "Line Cascade", "entrance", [
    group("Line Cascade", [sweep(1.1, { basedOn: "lines" })], {
      position: vec3(-40, 0, 0),
      opacity: staticValue(0),
    }),
  ]),
  preset("builtin.split-vertical", "Split Vertical", "entrance", [
    group(
      "Split Offset",
      [
        expressionSelector(
          `(${HALFWAY} - textIndex) / (abs(${HALFWAY} - textIndex) + 0.0001) * (1 - ${progress(`abs(${HALFWAY} - textIndex) * 0.04`, 0.5)}) * 100`,
        ),
      ],
      { position: vec3(0, -40, 0) },
    ),
    group(
      "Split Fade",
      [expressionSelector(`(1 - ${progress(`abs(${HALFWAY} - textIndex) * 0.04`, 0.5)}) * 100`)],
      { opacity: staticValue(0) },
    ),
  ]),
  preset("builtin.shear-in", "Shear In", "entrance", [
    group("Shear In", [sweep(0.8)], { skew: staticValue(45), opacity: staticValue(0) }),
  ]),
  preset("builtin.glitch-in", "Glitch In", "entrance", [
    group(
      "Glitch Offset",
      [
        expressionSelector(
          `(${hash(2.7, 31.7)} * 2 - 1) * (1 - ${progress(`${hash(4.1, 12.9898)} * 0.25`, 0.4)}) * 100`,
        ),
      ],
      { position: vec3(36, 0, 0) },
    ),
    group(
      "Glitch Color",
      [expressionSelector(`(1 - ${progress(`${hash(4.1, 12.9898)} * 0.25`, 0.4)}) * 100`)],
      { fillColor: rgba(1, 0.15, 0.3, 1) },
    ),
    group(
      "Glitch Flicker",
      [
        expressionSelector(
          `(1 - ${progress(`${hash(4.1, 12.9898)} * 0.25`, 0.4)}) * ((floor(time * 16 + textIndex * 0.7) % 2)) * 100`,
        ),
      ],
      { opacity: staticValue(0) },
    ),
  ]),
  preset("builtin.flicker-in", "Flicker In", "entrance", [
    group(
      "Flicker In",
      [
        expressionSelector(
          `(1 - ${progress(STAGGER, 0.4)}) * ((floor(time * 14 + textIndex * 0.618) % 2)) * 100`,
        ),
      ],
      { opacity: staticValue(0) },
    ),
  ]),
  preset("builtin.decode", "Decode", "entrance", [
    group("Decode", [expressionSelector(`(1 - ${progress(STAGGER, 0.5)}) * 100`)], {
      characterOffset: staticValue(25),
      characterRange: "preserveCaseAndDigits",
    }),
  ]),
  preset("builtin.fly-out", "Fly Out", "entrance", [
    group("Fly Out", [reverseSweep(0.8)], {
      position: vec3(0, -80, 0),
      scale: vec3(60, 60, 100),
      opacity: staticValue(0),
    }),
  ]),
  preset("builtin.shake", "Shake", "emphasis", [
    group("Shake", [wigglySelector({ wigglesPerSecond: 10, correlation: 5, randomSeed: 11 })], {
      position: vec3(5, 5, 0),
      rotation: vec3(0, 0, 3),
    }),
  ]),
  preset("builtin.wave", "Wave", "emphasis", [
    group("Wave", [expressionSelector("sin(time * 4 + (textIndex - 1) * 0.6) * 100")], {
      position: vec3(0, -24, 0),
    }),
  ]),
  preset("builtin.swing", "Swing", "emphasis", [
    group("Swing", [expressionSelector("sin(time * 3 + (textIndex - 1) * 0.4) * 100")], {
      rotation: vec3(0, 0, 10),
    }),
  ]),
  preset("builtin.pulse", "Pulse", "emphasis", [
    group("Pulse", [expressionSelector("(sin(time * 5 + (textIndex - 1) * 0.5) + 1) * 50")], {
      scale: vec3(112, 112, 100),
    }),
  ]),
  preset("builtin.color-flicker", "Color Flicker", "emphasis", [
    group(
      "Color Flicker",
      [wigglySelector({ minimumAmount: 0, wigglesPerSecond: 7, correlation: 25, randomSeed: 3 })],
      { fillColor: rgba(1, 0.2, 0.85, 1) },
    ),
  ]),
  preset("builtin.circular", "Circular Layout", "layout", [
    group("Ring X", [expressionSelector("cos((textIndex - 1) / textTotal * 2 * pi) * 100")], {
      position: vec3(170, 0, 0),
    }),
    group("Ring Y", [expressionSelector("sin((textIndex - 1) / textTotal * 2 * pi) * 100")], {
      position: vec3(0, 170, 0),
    }),
    group("Ring Tangent", [expressionSelector("(textIndex - 1) / textTotal * 80 + 20")], {
      rotation: vec3(0, 0, 450),
    }),
  ]),
];

function cloneAnimatable(value: Animatable, delta: number): Animatable {
  if (value.mode === "static") return { mode: "static", value: value.value };
  return {
    mode: "animated",
    keyframes: value.keyframes.map((keyframe) => ({
      ...keyframe,
      id: createId(),
      time: keyframe.time + delta,
    })),
  };
}

function cloneVector<T extends Animatable[]>(vector: T, delta: number): T {
  return vector.map((entry) => cloneAnimatable(entry, delta)) as T;
}

function cloneProperties(
  properties: TextAnimatorProperties,
  delta: number,
): TextAnimatorProperties {
  const cloned: TextAnimatorProperties = {};
  if (properties.anchorPoint) cloned.anchorPoint = cloneVector(properties.anchorPoint, delta);
  if (properties.position) cloned.position = cloneVector(properties.position, delta);
  if (properties.scale) cloned.scale = cloneVector(properties.scale, delta);
  if (properties.rotation) cloned.rotation = cloneVector(properties.rotation, delta);
  if (properties.skew) cloned.skew = cloneAnimatable(properties.skew, delta);
  if (properties.skewAxis) cloned.skewAxis = cloneAnimatable(properties.skewAxis, delta);
  if (properties.opacity) cloned.opacity = cloneAnimatable(properties.opacity, delta);
  if (properties.fillColor) cloned.fillColor = cloneVector(properties.fillColor, delta);
  if (properties.strokeColor) cloned.strokeColor = cloneVector(properties.strokeColor, delta);
  if (properties.strokeWidth) cloned.strokeWidth = cloneAnimatable(properties.strokeWidth, delta);
  if (properties.tracking) cloned.tracking = cloneAnimatable(properties.tracking, delta);
  if (properties.lineAnchor) cloned.lineAnchor = cloneAnimatable(properties.lineAnchor, delta);
  if (properties.lineSpacing) cloned.lineSpacing = cloneVector(properties.lineSpacing, delta);
  if (properties.characterOffset)
    cloned.characterOffset = cloneAnimatable(properties.characterOffset, delta);
  if (properties.characterValue)
    cloned.characterValue = cloneAnimatable(properties.characterValue, delta);
  if (properties.characterRange) cloned.characterRange = properties.characterRange;
  if (properties.blur) cloned.blur = cloneVector(properties.blur, delta);
  return cloned;
}

function cloneSelector(selector: TextSelector, delta: number): TextSelector {
  const common = {
    id: createId(),
    name: selector.name,
    enabled: selector.enabled,
    mode: selector.mode,
    amount: cloneAnimatable(selector.amount, delta),
    basedOn: selector.basedOn,
  };
  if (selector.kind === "range") {
    return {
      ...common,
      kind: "range",
      units: selector.units,
      start: cloneAnimatable(selector.start, delta),
      end: cloneAnimatable(selector.end, delta),
      offset: cloneAnimatable(selector.offset, delta),
      shape: selector.shape,
      smoothness: cloneAnimatable(selector.smoothness, delta),
      easeHigh: cloneAnimatable(selector.easeHigh, delta),
      easeLow: cloneAnimatable(selector.easeLow, delta),
      randomizeOrder: selector.randomizeOrder,
      randomSeed: selector.randomSeed,
    };
  }
  if (selector.kind === "wiggly") {
    return {
      ...common,
      kind: "wiggly",
      minimumAmount: cloneAnimatable(selector.minimumAmount, delta),
      maximumAmount: cloneAnimatable(selector.maximumAmount, delta),
      wigglesPerSecond: cloneAnimatable(selector.wigglesPerSecond, delta),
      correlation: cloneAnimatable(selector.correlation, delta),
      temporalPhase: cloneAnimatable(selector.temporalPhase, delta),
      spatialPhase: cloneAnimatable(selector.spatialPhase, delta),
      randomSeed: selector.randomSeed,
    };
  }
  return { ...common, kind: "expression", expression: selector.expression };
}

function cloneGroup(source: TextAnimatorGroup, delta: number): TextAnimatorGroup {
  return {
    id: createId(),
    name: source.name,
    enabled: source.enabled,
    randomSeed: source.randomSeed,
    selectors: source.selectors.map((selector) => cloneSelector(selector, delta)),
    properties: cloneProperties(source.properties, delta),
  };
}

function earliestKeyframeTime(groups: readonly TextAnimatorGroup[]): number {
  let earliest = Number.POSITIVE_INFINITY;
  const visit = (value: Animatable) => {
    if (value.mode !== "animated") return;
    for (const keyframe of value.keyframes) earliest = Math.min(earliest, keyframe.time);
  };
  const visitProperties = (properties: TextAnimatorProperties) => {
    for (const value of Object.values(properties)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object" && "mode" in value) visit(value);
    }
  };
  for (const animator of groups) {
    for (const selector of animator.selectors) {
      visit(selector.amount);
      if (selector.kind === "range") {
        visit(selector.start);
        visit(selector.end);
        visit(selector.offset);
        visit(selector.smoothness);
        visit(selector.easeHigh);
        visit(selector.easeLow);
      } else if (selector.kind === "wiggly") {
        visit(selector.minimumAmount);
        visit(selector.maximumAmount);
        visit(selector.wigglesPerSecond);
        visit(selector.correlation);
        visit(selector.temporalPhase);
        visit(selector.spatialPhase);
      }
    }
    visitProperties(animator.properties);
  }
  return earliest;
}

/**
 * Returns an independent copy of the preset's groups with fresh IDs and every
 * keyframe shifted so the first keyframe lands at `time`.
 */
export function instantiateTextAnimatorPreset(
  preset: TextAnimatorPreset,
  time: number,
): TextAnimatorGroup[] {
  const earliest = earliestKeyframeTime(preset.groups);
  const delta = Number.isFinite(earliest) ? time - earliest : 0;
  return preset.groups.map((animator) => cloneGroup(animator, delta));
}

/**
 * Builds a user preset from a layer's animator stack. Keyframes are rebased so
 * the earliest keyframe becomes time zero.
 */
export function createTextAnimatorPreset(
  name: string,
  groups: readonly TextAnimatorGroup[],
): TextAnimatorPreset {
  const normalized = normalizeTextAnimatorGroups(groups);
  const earliest = earliestKeyframeTime(normalized);
  const delta = Number.isFinite(earliest) ? -earliest : 0;
  return {
    id: createId(),
    name: name.trim().slice(0, 128) || "Preset",
    category: "entrance",
    builtIn: false,
    groups: normalized.map((animator) => cloneGroup(animator, delta)),
  };
}

export function serializeUserPresets(presets: readonly TextAnimatorPreset[]): string {
  const file: StoredPresetFile = {
    version: 1,
    presets: presets
      .filter((entry) => !entry.builtIn)
      .map((entry) => ({ id: entry.id, name: entry.name, groups: entry.groups })),
  };
  return JSON.stringify(file);
}

export function parseUserPresets(source: string): TextAnimatorPreset[] {
  try {
    const parsed = JSON.parse(source) as Partial<StoredPresetFile>;
    if (!parsed || !Array.isArray(parsed.presets)) return [];
    return parsed.presets.flatMap((entry) => {
      if (!entry || typeof entry.name !== "string" || !Array.isArray(entry.groups)) return [];
      return [
        {
          id: typeof entry.id === "string" && entry.id ? entry.id : createId(),
          name: entry.name.slice(0, 128) || "Preset",
          category: "entrance" as const,
          builtIn: false,
          groups: normalizeTextAnimatorGroups(entry.groups),
        },
      ];
    });
  } catch {
    return [];
  }
}

export function loadUserTextPresets(storage?: Storage): TextAnimatorPreset[] {
  const target = storage ?? safeStorage();
  if (!target) return [];
  return parseUserPresets(target.getItem(TEXT_ANIMATOR_PRESET_STORAGE_KEY) ?? "");
}

export function persistUserTextPresets(
  presets: readonly TextAnimatorPreset[],
  storage?: Storage,
): void {
  const target = storage ?? safeStorage();
  if (!target) return;
  try {
    target.setItem(TEXT_ANIMATOR_PRESET_STORAGE_KEY, serializeUserPresets(presets));
  } catch {
    // Quota or privacy-mode failures leave the previous preset file untouched.
  }
}

/** Serializes a single preset for file export. */
export function exportTextAnimatorPreset(preset: TextAnimatorPreset): string {
  return serializeUserPresets([{ ...preset, builtIn: false }]);
}

/** Parses a preset file into a user preset, or undefined when invalid. */
export function importTextAnimatorPreset(source: string): TextAnimatorPreset | undefined {
  return parseUserPresets(source)[0];
}

export function canAppendPresetGroups(
  groups: readonly TextAnimatorGroup[],
  existing: readonly TextAnimatorGroup[],
): boolean {
  return existing.length + groups.length <= MAX_TEXT_ANIMATOR_GROUPS;
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
