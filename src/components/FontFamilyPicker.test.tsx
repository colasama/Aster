// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FontFamilyPicker } from "./FontFamilyPicker";

let root: Root;
let input: HTMLInputElement;
const change = vi.fn();
const families = Array.from({ length: 10_000 }, (_, i) => `Font ${String(i).padStart(5, "0")}`);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  change.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <FontFamilyPicker
        value="Arial, sans-serif"
        families={families}
        label="Font family"
        emptyLabel="No matches"
        loading={false}
        onOpen={() => {}}
        onChange={change}
      />,
    ),
  );
  input = container.querySelector("input") as HTMLInputElement;
  act(() => input.focus());
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

function key(key: string) {
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key })));
}

function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("bounds DOM size for 10,000 fonts and scrolls distant keyboard selections into view", () => {
  expect(document.querySelectorAll('[role="option"]').length).toBeLessThanOrEqual(15);
  expect(document.querySelector('[role="option"]')?.getAttribute("aria-setsize")).toBe("10000");
  const list = document.querySelector('[role="listbox"]') as HTMLElement;
  act(() => {
    list.scrollTop = 140_000;
    list.dispatchEvent(new Event("scroll"));
  });
  expect(document.querySelectorAll('[role="option"]').length).toBeLessThanOrEqual(15);
  expect(document.querySelector('[role="option"]')?.textContent).toBe("Font 04997");
  key("ArrowDown");
  key("End");
  expect(
    document.getElementById(input.getAttribute("aria-activedescendant") ?? "")?.textContent,
  ).toBe("Font 09999");
  expect(document.querySelectorAll('[role="option"]').length).toBeLessThanOrEqual(15);
  key("Enter");
  expect(change).toHaveBeenCalledExactlyOnceWith('"Font 09999"');
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});

it("filters without editing the project and commits a clicked match once", () => {
  type("09999");
  expect(change).not.toHaveBeenCalled();
  const option = document.querySelector('[role="option"]') as HTMLElement;
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  act(() => option.click());
  act(() => input.blur());
  expect(change).toHaveBeenCalledExactlyOnceWith('"Font 09999"');
});

it("cancels with Escape and preserves custom CSS stacks on blur", () => {
  type("cancelled");
  key("Escape");
  expect(input.value).toBe("Arial, sans-serif");
  act(() => input.blur());
  expect(change).not.toHaveBeenCalled();
  act(() => input.focus());
  type('"Custom Font", serif');
  expect(document.querySelector('[role="status"]')?.textContent).toBe("No matches");
  act(() => input.blur());
  expect(change).toHaveBeenCalledExactlyOnceWith('"Custom Font", serif');
});
