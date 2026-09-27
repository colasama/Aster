import { describe, expect, it } from "vitest";
import { staticValue } from "../types";
import {
  BUILT_IN_TEXT_PRESETS,
  canAppendPresetGroups,
  createTextAnimatorPreset,
  exportTextAnimatorPreset,
  importTextAnimatorPreset,
  instantiateTextAnimatorPreset,
  loadUserTextPresets,
  parseUserPresets,
  persistUserTextPresets,
  serializeUserPresets,
  TEXT_ANIMATOR_PRESET_STORAGE_KEY,
} from "./text-animator-presets";
import type { TextAnimatorGroup } from "./text-animator-stack";
import {
  safeEvaluateTextSelectorExpression,
  textSelectorExpressionError,
} from "./text-selector-expression";
import { evaluateTextSelectors, type TextSelector } from "./text-selectors";

function animatedGroup(): TextAnimatorGroup {
  return {
    id: "group-1",
    name: "Fade",
    enabled: true,
    randomSeed: 0,
    selectors: [
      {
        id: "selector-1",
        name: "Range Selector 1",
        kind: "range",
        enabled: true,
        mode: "add",
        amount: staticValue(100),
        basedOn: "characters",
        units: "percentage",
        start: {
          mode: "animated",
          keyframes: [
            { id: "key-1", time: 4, value: 0, interpolation: "linear" },
            { id: "key-2", time: 6, value: 100, interpolation: "linear" },
          ],
        },
        end: staticValue(100),
        offset: staticValue(0),
        shape: "square",
        smoothness: staticValue(100),
        easeHigh: staticValue(0),
        easeLow: staticValue(0),
        randomizeOrder: false,
        randomSeed: 0,
      },
    ],
    properties: { opacity: staticValue(0) },
  };
}

describe("instantiateTextAnimatorPreset", () => {
  it("shifts keyframes so the earliest lands at the requested time", () => {
    const [group] = instantiateTextAnimatorPreset(
      { id: "p", name: "P", category: "entrance", builtIn: false, groups: [animatedGroup()] },
      10,
    );
    const start = group?.selectors[0];
    if (start?.kind !== "range" || start.start.mode !== "animated")
      throw new Error("expected animated start");
    expect(start.start.keyframes.map((keyframe) => keyframe.time)).toEqual([10, 12]);
  });

  it("regenerates group, selector and keyframe ids", () => {
    const preset = {
      id: "p",
      name: "P",
      category: "entrance" as const,
      builtIn: false,
      groups: [animatedGroup()],
    };
    const [first] = instantiateTextAnimatorPreset(preset, 0);
    const [second] = instantiateTextAnimatorPreset(preset, 0);
    expect(first?.id).not.toBe("group-1");
    expect(first?.id).not.toBe(second?.id);
    expect(first?.selectors[0]?.id).not.toBe("selector-1");
    const start = first?.selectors[0];
    if (start?.kind !== "range" || start.start.mode !== "animated")
      throw new Error("expected animated start");
    expect(start.start.keyframes[0]?.id).not.toBe("key-1");
  });

  it("leaves static tracks untouched", () => {
    const [group] = instantiateTextAnimatorPreset(
      { id: "p", name: "P", category: "entrance", builtIn: false, groups: [animatedGroup()] },
      3,
    );
    const start = group?.selectors[0];
    if (start?.kind !== "range" || start.end.mode !== "static")
      throw new Error("expected static end");
    expect(start.end.value).toBe(100);
  });
});

describe("createTextAnimatorPreset", () => {
  it("rebases keyframes relative to the earliest keyframe", () => {
    const preset = createTextAnimatorPreset("My preset", [animatedGroup()]);
    const selector = preset.groups[0]?.selectors[0];
    if (selector?.kind !== "range" || selector.start.mode !== "animated")
      throw new Error("expected animated start");
    expect(selector.start.keyframes.map((keyframe) => keyframe.time)).toEqual([0, 2]);
  });
});

describe("user preset storage", () => {
  it("round-trips presets through serialization", () => {
    const preset = createTextAnimatorPreset("Round trip", [animatedGroup()]);
    const parsed = parseUserPresets(serializeUserPresets([preset]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe("Round trip");
    expect(parsed[0]?.builtIn).toBe(false);
    expect(parsed[0]?.groups[0]?.properties.opacity).toEqual(staticValue(0));
  });

  it("returns an empty list for malformed input", () => {
    expect(parseUserPresets("not json")).toEqual([]);
    expect(parseUserPresets('{"version":1}')).toEqual([]);
    expect(parseUserPresets('{"version":1,"presets":[{"name":"x"}]}')).toEqual([]);
  });

  it("persists to and loads from storage", () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
    } as unknown as Storage;
    const preset = createTextAnimatorPreset("Stored", [animatedGroup()]);
    persistUserTextPresets([preset], storage);
    expect(backing.has(TEXT_ANIMATOR_PRESET_STORAGE_KEY)).toBe(true);
    const loaded = loadUserTextPresets(storage);
    expect(loaded.map((entry) => entry.name)).toEqual(["Stored"]);
  });

  it("exports and imports a single preset file", () => {
    const source = BUILT_IN_TEXT_PRESETS[0];
    if (!source) throw new Error("expected built-in presets");
    const imported = importTextAnimatorPreset(exportTextAnimatorPreset(source));
    expect(imported?.name).toBe(source.name);
    expect(imported?.builtIn).toBe(false);
  });
});

describe("canAppendPresetGroups", () => {
  it("enforces the animator group cap", () => {
    expect(canAppendPresetGroups([animatedGroup()], [])).toBe(true);
    const full = Array.from({ length: 32 }, () => animatedGroup());
    expect(canAppendPresetGroups([animatedGroup()], full)).toBe(false);
  });
});

describe("built-in presets", () => {
  it("ships a non-empty pack covering all categories", () => {
    expect(BUILT_IN_TEXT_PRESETS.length).toBeGreaterThanOrEqual(15);
    for (const category of ["entrance", "emphasis", "layout"]) {
      expect(BUILT_IN_TEXT_PRESETS.some((preset) => preset.category === category)).toBe(true);
    }
  });

  it("uses only compilable selector expressions", () => {
    for (const preset of BUILT_IN_TEXT_PRESETS) {
      for (const group of preset.groups) {
        for (const selector of group.selectors) {
          if (selector.kind !== "expression") continue;
          expect(
            textSelectorExpressionError(selector.expression),
            `${preset.name}: ${selector.expression}`,
          ).toBeUndefined();
        }
      }
    }
  });

  it("produces finite bounded selector values across units and time", () => {
    const unit = {
      characterIndex: 0,
      characterCount: 8,
      characterExcludingSpacesIndex: 0,
      characterExcludingSpacesCount: 8,
      wordIndex: 0,
      wordCount: 4,
      lineIndex: 0,
      lineCount: 2,
      isWhitespace: false,
    };
    const evaluateExpression = safeEvaluateTextSelectorExpression;
    for (const preset of BUILT_IN_TEXT_PRESETS) {
      for (const group of preset.groups) {
        for (let index = 0; index < 8; index += 1) {
          for (const time of [0, 0.5, 2]) {
            const value = evaluateTextSelectors(
              group.selectors,
              { ...unit, characterIndex: index },
              {
                time,
                evaluateExpression,
              },
            );
            expect(Number.isFinite(value), preset.name).toBe(true);
            expect(Math.abs(value)).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("contains no duplicated ids inside a single preset instance", () => {
    for (const preset of BUILT_IN_TEXT_PRESETS) {
      const groups = instantiateTextAnimatorPreset(preset, 0);
      const ids = new Set<string>();
      const visit = (selector: TextSelector) => {
        expect(ids.has(selector.id)).toBe(false);
        ids.add(selector.id);
      };
      for (const group of groups) {
        expect(ids.has(group.id)).toBe(false);
        ids.add(group.id);
        group.selectors.forEach(visit);
      }
    }
  });
});
