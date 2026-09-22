// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDefaultRangeSelector,
  createDefaultTextAnimatorGroup,
  MAX_TEXT_SELECTORS_PER_GROUP,
} from "../../core/animation/text-animator-groups";
import {
  MAX_TEXT_ANIMATOR_GROUPS,
  type TextAnimatorStackSettings,
} from "../../core/animation/text-animator-stack";
import { I18nProvider } from "../../i18n/react";
import { TextAnimatorControls } from "./TextAnimatorControls";

let root: Root | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem("aster.locale", "en-US");
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("text animator inspector", () => {
  it("adds all transforms without replacing existing values or keyframes", () => {
    const container = renderControls(1.25);
    click(button(container, "Toggle Position keyframe"));
    const position = container.querySelector<HTMLInputElement>('input[aria-label="Position X"]');
    if (!position) throw new Error("Expected position control");
    change(position, "42");
    const propertyKind = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Add property"]',
    );
    if (!propertyKind) throw new Error("Expected property control");
    change(propertyKind, "allTransforms");
    click(
      [...container.querySelectorAll("button")].find((entry) =>
        entry.textContent?.includes("Add property"),
      ),
    );
    expect(position.value).toBe("42");
    expect(button(container, "Toggle Position keyframe").getAttribute("aria-pressed")).toBe("true");
    for (const label of ["Anchor point", "Scale", "Rotation", "Skew", "Skew axis", "Opacity"])
      expect(button(container, `Remove ${label}`)).toBeDefined();
    expect(propertyKind.querySelector('option[value="allTransforms"]')).toBeNull();
  });

  it("adds the skew axis alongside skew", () => {
    const container = renderControls();
    const propertyKind = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Add property"]',
    );
    if (!propertyKind) throw new Error("Expected property control");
    change(propertyKind, "skew");
    click(
      [...container.querySelectorAll("button")].find((entry) =>
        entry.textContent?.includes("Add property"),
      ),
    );
    expect(button(container, "Remove Skew axis")).toBeDefined();
  });

  it("adds, renames, reorders, and removes animator groups and selectors", () => {
    const container = renderControls();
    click(button(container, "Add animator"));
    const names = [
      ...container.querySelectorAll<HTMLInputElement>('input[aria-label="Animator name"]'),
    ];
    expect(names).toHaveLength(2);
    change(names[1] as HTMLInputElement, "Secondary");
    click(button(container, "Move Secondary up"));
    expect(
      [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Animator name"]')].map(
        (input) => input.value,
      ),
    ).toEqual(["Secondary", "Animator 1"]);

    const selectorKind = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Add selector"]',
    );
    if (!selectorKind) throw new Error("Expected selector kind control");
    change(selectorKind, "expression");
    click(
      [...container.querySelectorAll("button")].find((entry) =>
        entry.textContent?.includes("Add selector"),
      ),
    );
    const selectorNames = [
      ...container.querySelectorAll<HTMLInputElement>('input[aria-label="Selector name"]'),
    ];
    expect(selectorNames.map((input) => input.value)).toContain("Expression Selector 1");
    const expressionName = selectorNames[selectorNames.length - 1];
    if (!expressionName) throw new Error("Expected selector name control");
    change(expressionName, "Secondary Expression");
    expect(expressionName.value).toBe("Secondary Expression");
    while (container.querySelector<HTMLButtonElement>('button[aria-label="Remove selector"]'))
      click(container.querySelector<HTMLButtonElement>('button[aria-label="Remove selector"]'));
    expect(container.querySelector(".text-selector-control")).toBeNull();
  });

  it("creates keyframes at the addressed time and surfaces expression errors", () => {
    const container = renderControls(1.25);
    click(button(container, "Toggle Start keyframe"));
    expect(button(container, "Toggle Start keyframe").getAttribute("aria-pressed")).toBe("true");

    const selectorKind = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Add selector"]',
    );
    if (!selectorKind) throw new Error("Expected selector kind control");
    change(selectorKind, "expression");
    click(
      [...container.querySelectorAll("button")].find((entry) =>
        entry.textContent?.includes("Add selector"),
      ),
    );
    const expression = container.querySelector<HTMLTextAreaElement>(
      ".text-expression-field textarea",
    );
    if (!expression) throw new Error("Expected expression editor");
    change(expression, "globalThis.alert(1)");
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/invalid|Unsupported/u);
    expect(expression.getAttribute("aria-invalid")).toBe("true");
  });

  it("duplicates groups and selectors immediately after their source", () => {
    const container = renderControls();
    click(button(container, "Duplicate Animator 1"));
    expect(
      [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Animator name"]')].map(
        (input) => input.value,
      ),
    ).toEqual(["Animator 1", "Animator 1 Copy"]);

    click(button(container, "Duplicate Range Selector 1"));
    expect(
      [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Selector name"]')].map(
        (input) => input.value,
      ),
    ).toEqual(["Range Selector 1", "Range Selector 1 Copy", "Range Selector 1"]);
  });

  it("disables duplicate actions at the group and selector limits", () => {
    const groups = Array.from({ length: MAX_TEXT_ANIMATOR_GROUPS }, (_, index) =>
      createDefaultTextAnimatorGroup(index),
    );
    const firstGroup = groups[0];
    if (!firstGroup) throw new Error("Expected an animator group fixture");
    groups[0] = {
      ...firstGroup,
      selectors: Array.from({ length: MAX_TEXT_SELECTORS_PER_GROUP }, (_, index) =>
        createDefaultRangeSelector(index),
      ),
    };
    const container = renderControls(0, { enabled: true, groups });

    expect(button(container, "Duplicate Animator 1").disabled).toBe(true);
    expect(button(container, "Duplicate Range Selector 1").disabled).toBe(true);
  });

  it("adds the character range control with a preservation default", () => {
    const container = renderControls();
    const propertyKind = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Add property"]',
    );
    if (!propertyKind) throw new Error("Expected property kind control");
    change(propertyKind, "characterOffset");
    click(
      [...container.querySelectorAll("button")].find((entry) =>
        entry.textContent?.includes("Add property"),
      ),
    );
    const range = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Character range"]',
    );
    if (!range) throw new Error("Expected character range control");
    expect(range.value).toBe("preserveCaseAndDigits");
    change(range, "fullUnicode");
    expect(range.value).toBe("fullUnicode");
  });

  it("localizes the stack controls in Chinese", () => {
    window.localStorage.setItem("aster.locale", "zh-CN");
    const container = renderControls();
    expect(container.textContent).toContain("文字动画器");
    expect(container.textContent).toContain("范围选择器");
    expect(container.textContent).toContain("添加属性");
  });
});

function renderControls(time = 0, initialSettings?: TextAnimatorStackSettings): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <I18nProvider>
        <Harness initialSettings={initialSettings} time={time} />
      </I18nProvider>,
    ),
  );
  return container;
}

function Harness({
  initialSettings,
  time,
}: {
  initialSettings?: TextAnimatorStackSettings;
  time: number;
}) {
  const [settings, setSettings] = useState<TextAnimatorStackSettings>(
    initialSettings ?? {
      enabled: true,
      groups: [createDefaultTextAnimatorGroup(0)],
    },
  );
  return <TextAnimatorControls onChange={setSettings} settings={settings} time={time} />;
}

function button(container: ParentNode, label: string): HTMLButtonElement {
  const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!result) throw new Error(`Expected ${label} button`);
  return result;
}

function click(target: Element | null | undefined): void {
  if (!target) throw new Error("Expected clickable element");
  act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function change(target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype =
      target instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : target instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
