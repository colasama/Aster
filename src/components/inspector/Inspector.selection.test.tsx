// @vitest-environment happy-dom
import { act } from "react";
import { expect, it } from "vitest";
import { evaluateAnimatable } from "../../core/animation/timeline";
import { activeComposition } from "../../core/project/project";
import { createEffect } from "../../effects/registry";
import {
  change,
  editor,
  field,
  flush,
  inputValue,
  key,
  layerProject,
  layers,
  mount,
  pointer,
  select,
  setupInspectorTests,
} from "./inspector-selection-test-utils";

setupInspectorTests();

it("shows common values per axis and assigns mixed values even when they equal the first layer", () => {
  mount(layerProject());
  expect(document.querySelector(".selected-layer-card strong")?.textContent).toBe(
    "2 layers selected",
  );
  expect(field().value).toBe("");
  expect(field().placeholder).toBe("—");
  expect(field("Position Y").value).not.toBe("");
  const before = layers();
  change(field(), "10");
  expect(layers().map((layer) => evaluateAnimatable(layer.transform.position[0], 1))).toEqual([
    10, 10,
  ]);
  expect(layers().map((layer) => layer.transform.position[1])).toEqual(
    before.map((layer) => layer.transform.position[1]),
  );
  expect(editor.state.history.past).toHaveLength(1);
  act(() => editor.dispatch({ type: "undo" }));
  expect(layers()).toEqual(before);
  expect(field().placeholder).toBe("—");
  act(() => editor.dispatch({ type: "redo" }));
  expect(field().value).toBe("10");
});

it("does not turn mixed or abandoned drafts into zero", () => {
  mount(layerProject());
  const before = layers();
  pointer(field(), "pointerdown", 100);
  pointer(window, "pointerup", 100);
  key(field(), "Enter");
  inputValue(field(), "99");
  key(field(), "Escape");
  inputValue(field(), "");
  key(field(), "Enter");
  expect(layers()).toEqual(before);
  expect(editor.state.history.past).toHaveLength(0);
});

it("keeps copied values when changing selection and pastes into every selected layer", () => {
  const project = layerProject();
  const ids = activeComposition(project).layers.map((layer) => layer.id);
  mount(project);
  const menuItem = (label: string) => {
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (element) => element.textContent?.includes(label),
    );
    if (!item) throw new Error(`Missing menu item ${label}`);
    return item;
  };
  act(() => editor.dispatch({ type: "select", ids: [ids[0]] }));
  key(field(), "ContextMenu");
  act(() => menuItem("Copy Value").click());
  act(() => editor.dispatch({ type: "select", ids }));
  key(field(), "ContextMenu");
  expect(menuItem("Copy Value").getAttribute("aria-disabled")).toBe("true");
  expect(menuItem("Paste Value").getAttribute("aria-disabled")).not.toBe("true");
  act(() => menuItem("Paste Value").click());
  expect(layers().map((layer) => evaluateAnimatable(layer.transform.position[0], 1))).toEqual([
    10, 10,
  ]);
  expect(editor.state.history.past).toHaveLength(1);
});

it("edits unlocked layers when the first selected layer is locked", () => {
  const project = layerProject();
  activeComposition(project).layers[0].locked = true;
  mount(project);
  expect(field().disabled).toBe(false);
  change(field(), "35");
  expect(layers().map((layer) => evaluateAnimatable(layer.transform.position[0], 1))).toEqual([
    10, 35,
  ]);
  expect(field().placeholder).toBe("—");
});

it.each(["commit", "Escape", "pointercancel", "seek", "selection"])(
  "handles a mixed static/animated scrub on %s",
  (finish) => {
    const project = layerProject("solid", 3);
    const originals = activeComposition(project).layers;
    for (const [index, layer] of originals.entries()) {
      if (index === 2) continue;
      layer.transform.position[0] = {
        mode: "animated",
        keyframes: [
          { id: `a${index}`, time: 0, value: index * 20, interpolation: "linear" },
          { id: `b${index}`, time: 2, value: 100 + index * 20, interpolation: "linear" },
        ],
      };
    }
    mount(project);
    pointer(field(), "pointerdown", 100);
    pointer(window, "pointermove", 110);
    flush();
    const inserted = layers()
      .slice(0, 2)
      .map((layer) => layer.transform.position[0]);
    pointer(window, "pointermove", 125);
    flush();
    expect(layers().map((layer) => evaluateAnimatable(layer.transform.position[0], 1))).toEqual([
      75, 75, 75,
    ]);
    layers()
      .slice(0, 2)
      .forEach((layer, index) => {
        const current = layer.transform.position[0];
        const previous = inserted[index];
        if (current.mode !== "animated" || previous.mode !== "animated")
          throw new Error("Expected animated tracks");
        expect(current.keyframes.map((keyframe) => keyframe.id)).toEqual(
          previous.keyframes.map((keyframe) => keyframe.id),
        );
        expect(current.keyframes.filter((keyframe) => keyframe.time !== 1)).toEqual(
          originals[index].transform.position[0].mode === "animated"
            ? originals[index].transform.position[0].keyframes
            : [],
        );
      });
    expect(layers()[2].transform.position[0].mode).toBe("static");
    if (finish === "commit") {
      pointer(window, "pointerup", 125);
      expect(editor.state.history.past).toHaveLength(1);
      act(() => editor.dispatch({ type: "undo" }));
    } else if (finish === "seek") act(() => editor.dispatch({ type: "setTime", time: 1.5 }));
    else if (finish === "selection")
      act(() => editor.dispatch({ type: "select", ids: [originals[0].id, originals[2].id] }));
    else if (finish === "Escape") key(window, "Escape");
    else pointer(window, "pointercancel", 125);
    expect(layers()).toEqual(originals);
    expect(editor.state.history.past).toHaveLength(0);
  },
);

it("compares evaluated values at the current time and only exposes shared dimensions", () => {
  const project = layerProject();
  const selected = activeComposition(project).layers;
  selected[0].transform.position[0] = {
    mode: "animated",
    keyframes: [
      { id: "a", time: 0, value: 0, interpolation: "linear" },
      { id: "b", time: 2, value: 40, interpolation: "linear" },
    ],
  };
  selected[1].threeDimensional = true;
  mount(project);
  expect(field().value).toBe("20");
  expect(document.querySelector('input[aria-label="Position Z"]')).toBeNull();
  act(() => editor.dispatch({ type: "setTime", time: 0 }));
  expect(field().placeholder).toBe("—");
});

it("unifies a mixed blend mode and its opacity in one operation per edit", () => {
  const project = layerProject();
  activeComposition(project).layers[1].blendMode = "multiply";
  activeComposition(project).layers[1].transform.opacity = { mode: "static", value: 40 };
  mount(project);
  const blend = document.querySelector<HTMLSelectElement>(".layer-blend-options select");
  if (!blend) throw new Error("Missing blend control");
  expect(blend.selectedOptions[0]?.text).toBe("—");
  select(blend, "normal");
  expect(layers().map((layer) => layer.blendMode)).toEqual(["normal", "normal"]);
  const opacity = document.querySelector<HTMLInputElement>(".layer-blend-options input");
  if (!opacity) throw new Error("Missing opacity");
  change(opacity, "100");
  expect(layers().map((layer) => evaluateAnimatable(layer.transform.opacity, 1))).toEqual([
    100, 100,
  ]);
  expect(editor.state.history.past).toHaveLength(2);
});

it("matches repeated effects by type occurrence and preserves their other parameters", () => {
  const project = layerProject();
  const selected = activeComposition(project).layers;
  selected[0].effects = [createEffect("glow"), createEffect("glow")];
  selected[1].effects = [createEffect("gaussian-blur"), createEffect("glow"), createEffect("glow")];
  selected[0].effects[0].parameters.intensity = 1;
  selected[1].effects[1].parameters.intensity = 2;
  selected[1].effects[1].parameters.radius = 17;
  selected[1].effects[2].parameters.intensity = 3;
  mount(project);
  expect(document.querySelectorAll(".effect-editor")).toHaveLength(2);
  const before = layers();
  change(field("Glow Intensity"), "1");
  expect(layers()[0].effects[0].parameters.intensity).toBe(1);
  expect(layers()[1].effects[1].parameters.intensity).toBe(1);
  expect(layers()[1].effects[1].parameters.radius).toBe(17);
  expect(layers()[1].effects[2]).toEqual(before[1].effects[2]);
  expect(layers()[1].effects[0]).toEqual(before[1].effects[0]);
  act(() => editor.dispatch({ type: "undo" }));
  expect(layers()).toEqual(before);
});

it("restores all animated effect tracks on scrub cancellation", () => {
  const project = layerProject();
  activeComposition(project).layers.forEach((layer, index) => {
    const effect = createEffect("glow");
    effect.parameterKeyframes = {
      intensity: [
        { id: `a${index}`, time: 0, value: index, interpolation: "linear" },
        { id: `b${index}`, time: 2, value: index + 2, interpolation: "linear" },
      ],
    };
    layer.effects = [effect];
  });
  mount(project);
  const before = layers();
  pointer(field("Glow Intensity"), "pointerdown", 100);
  pointer(window, "pointermove", 120);
  flush();
  pointer(window, "pointermove", 130);
  flush();
  key(window, "Escape");
  expect(layers()).toEqual(before);
  expect(editor.state.history.past).toHaveLength(0);
});
