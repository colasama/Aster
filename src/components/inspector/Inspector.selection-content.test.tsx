// @vitest-environment happy-dom
import { act } from "react";
import { expect, it } from "vitest";
import { createDefaultTextAnimatorGroup } from "../../core/animation/text-animator-groups";
import { evaluateAnimatable } from "../../core/animation/timeline";
import { resolveTextStyle } from "../../core/layers/text-style";
import { activeComposition } from "../../core/project/project";
import {
  createParticleSceneGenerator,
  particleSettingsFromGenerator,
} from "../../core/scene/bundled-particle";
import { createDefaultParticleSettings } from "../../core/scene/particle-settings";
import { staticValue } from "../../core/types";
import { createEffect } from "../../effects/registry";
import { createDefaultBezierPath } from "../../renderer/geometry/vector-path";
import { normalizedDefaultCloner } from "./ClonerControls";
import {
  change,
  editor,
  field,
  inputValue,
  layerProject,
  layers,
  mount,
  select,
  setupInspectorTests,
} from "./inspector-selection-test-utils";

setupInspectorTests();

it("edits text, font and style fields without copying unrelated styles", () => {
  const project = layerProject("text");
  const selected = activeComposition(project).layers;
  selected.forEach((layer, index) => {
    layer.text = `Text ${index}`;
    layer.textStyle = {
      ...resolveTextStyle(layer),
      fontFamily: index ? "serif" : "sans-serif",
      fontSize: 30 + index * 20,
      tracking: index * 12,
    };
  });
  mount(project);
  expect(field("Font size").placeholder).toBe("—");
  change(field("Font size"), "30");
  expect(layers().map((layer) => layer.textStyle?.fontSize)).toEqual([30, 30]);
  expect(layers().map((layer) => layer.textStyle?.tracking)).toEqual([0, 12]);
  expect(layers().map((layer) => layer.textStyle?.fontFamily)).toEqual(["sans-serif", "serif"]);
  const font = document.querySelector<HTMLInputElement>('input[role="combobox"]');
  if (!font) throw new Error("Missing font picker");
  expect(font.placeholder).toBe("—");
  const content = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Text content"]',
  );
  if (!content) throw new Error("Missing text content");
  expect(content.value).toBe("");
  expect(content.placeholder).toBe("—");
  inputValue(content, "Shared text");
  expect(layers().map((layer) => layer.text)).toEqual(["Shared text", "Shared text"]);
  expect(editor.state.history.past).toHaveLength(2);
});

it("keeps solid dimensions and opacity independent when setting a shared color", () => {
  const project = layerProject();
  const selected = activeComposition(project).layers;
  selected.forEach((layer, index) => {
    if (!layer.solid) throw new Error("Missing solid");
    layer.solid = {
      ...layer.solid,
      width: 100 + index * 20,
      height: 200 + index * 30,
      color: [index, 0, 0, 0.5 + index * 0.5],
    };
  });
  mount(project);
  change(field("Solid width"), "100");
  expect(layers().map((layer) => layer.solid?.width)).toEqual([100, 100]);
  expect(layers().map((layer) => layer.solid?.height)).toEqual([200, 230]);
  const color = document.querySelector<HTMLInputElement>(
    '.layer-content-section input[type="color"]',
  );
  if (!color) throw new Error("Missing solid color");
  expect(color.closest(".mixed-color-input")?.textContent).toBe("—");
  inputValue(color, "#00ff00");
  expect(layers().map((layer) => layer.solid?.color)).toEqual([
    [0, 1, 0, 0.5],
    [0, 1, 0, 1],
  ]);
});

it("edits a shared mask coordinate while retaining each mask's other settings", () => {
  const project = layerProject();
  activeComposition(project).layers.forEach((layer, index) => {
    const effect = createEffect("glow");
    effect.mask = {
      shape: "ellipse",
      center: [30 + index * 10, 40 + index * 10],
      size: [55, 55],
      feather: 12 + index * 5,
      opacity: 100,
      invert: index === 1,
    };
    layer.effects = [effect];
  });
  mount(project);
  const x = document.querySelector<HTMLInputElement>('.effect-mask-pair input[type="number"]');
  if (!x) throw new Error("Missing mask X");
  expect(x.placeholder).toBe("—");
  change(x, "30");
  expect(layers().map((layer) => layer.effects[0].mask?.center)).toEqual([
    [30, 40],
    [30, 50],
  ]);
  const invert = document.querySelector<HTMLInputElement>(
    '.effect-mask-heading input[type="checkbox"]',
  );
  if (!invert) throw new Error("Missing invert");
  expect(invert.indeterminate).toBe(true);
  act(() => invert.click());
  expect(layers().map((layer) => layer.effects[0].mask?.invert)).toEqual([true, true]);
  expect(layers().map((layer) => layer.effects[0].mask?.feather)).toEqual([12, 17]);
});

it("edits nested shape trim fields without overwriting paths or other trim fields", () => {
  const project = layerProject("shape");
  activeComposition(project).layers.forEach((layer, index) => {
    if (!layer.shape) throw new Error("Missing shape");
    layer.shape = {
      ...layer.shape,
      kind: "bezier",
      path: createDefaultBezierPath(),
      trim: { start: 10 + index * 10, end: 60 + index * 20, offset: index * 10 },
    };
  });
  mount(project);
  const trim = document.querySelector<HTMLInputElement>('input[aria-label="Trim start"]');
  if (!trim) throw new Error("Missing trim start");
  expect(trim.placeholder).toBe("—");
  change(trim, "10");
  expect(layers().map((layer) => layer.shape?.trim)).toEqual([
    { start: 10, end: 60, offset: 0 },
    { start: 10, end: 80, offset: 10 },
  ]);
});

it("updates nested animator tracks at each layer's source time and preserves sibling tracks and IDs", () => {
  const project = layerProject("text");
  activeComposition(project).layers.forEach((layer, index) => {
    const group = createDefaultTextAnimatorGroup(0);
    group.properties.position = [
      {
        mode: "animated",
        keyframes: [
          { id: `start${index}`, time: 0, value: index * 10, interpolation: "linear" },
          { id: `end${index}`, time: 4, value: 100, interpolation: "linear" },
        ],
      },
      staticValue(20 + index * 10),
      staticValue(0),
    ];
    layer.textAnimator = { enabled: true, groups: [group] };
    layer.timeOffset = index;
  });
  mount(project);
  const before = layers();
  const x = document.querySelector<HTMLInputElement>(
    '.text-animator-property input[aria-label="Position X"]',
  );
  if (!x) throw new Error("Missing animator position");
  expect(x.placeholder).toBe("—");
  change(x, "42");
  layers().forEach((layer, index) => {
    const group = layer.textAnimator?.groups[0];
    expect(group?.id).toBe(before[index].textAnimator?.groups[0]?.id);
    expect(group?.properties.position?.[1]).toEqual(staticValue(20 + index * 10));
    const track = group?.properties.position?.[0];
    if (track?.mode !== "animated") throw new Error("Missing animated position");
    expect(track.keyframes).toHaveLength(3);
    expect(evaluateAnimatable(track, 1 + index)).toBe(42);
  });
  act(() => editor.dispatch({ type: "undo" }));
  expect(layers()).toEqual(before);
});

it("updates particle and cloner vector components without flattening the other axes", () => {
  const project = layerProject("generator");
  activeComposition(project).layers.forEach((layer, index) => {
    layer.generator = createParticleSceneGenerator({
      ...createDefaultParticleSettings(),
      velocity: [1 + index, 5 + index, 0],
    });
    layer.cloner = normalizedDefaultCloner();
    layer.cloner.distribution = {
      kind: "grid",
      count: [3 + index, 1 + index, 1],
      spacing: [200, 100, 0],
    };
  });
  mount(project);
  change(field("Velocity X"), "1");
  expect(layers().map((layer) => particleSettingsFromGenerator(layer.generator)?.velocity)).toEqual(
    [
      [1, 5, 0],
      [1, 6, 0],
    ],
  );
  const count = document.querySelector<HTMLInputElement>('.cloner-vector input[type="number"]');
  if (!count) throw new Error("Missing clone count");
  expect(count.placeholder).toBe("—");
  change(count, "3");
  expect(layers().map((layer) => layer.cloner?.distribution.count)).toEqual([
    [3, 1, 1],
    [3, 2, 1],
  ]);
});

it("supports shared camera controls while preserving each camera's optics", () => {
  const project = layerProject("camera");
  activeComposition(project).layers.forEach((layer, index) => {
    if (!layer.camera) throw new Error("Missing camera");
    layer.camera.zoom = staticValue(500 + index * 500);
    layer.camera.filmSize = staticValue(24 + index * 12);
  });
  mount(project);
  expect(field("Zoom").placeholder).toBe("—");
  change(field("Zoom"), "500");
  expect(layers().map((layer) => layer.camera && evaluateAnimatable(layer.camera.zoom, 1))).toEqual(
    [500, 500],
  );
  expect(
    layers().map((layer) => layer.camera && evaluateAnimatable(layer.camera.filmSize, 1)),
  ).toEqual([24, 36]);
  const projection = document.querySelector<HTMLSelectElement>(
    'select[aria-label="Camera projection"]',
  );
  if (!projection) throw new Error("Missing camera projection");
  select(projection, "orthographic");
  expect(layers().map((layer) => layer.camera?.projection)).toEqual([
    "orthographic",
    "orthographic",
  ]);
});

it("hides fields and effects missing from any selected layer", () => {
  const project = layerProject("text");
  const selected = activeComposition(project).layers;
  selected[1].kind = "shape";
  selected[0].effects = [createEffect("glow")];
  mount(project);
  expect(document.querySelector('textarea[aria-label="Text content"]')).toBeNull();
  expect(document.querySelector(".effect-editor")).toBeNull();
  expect(field()).toBeDefined();
});
