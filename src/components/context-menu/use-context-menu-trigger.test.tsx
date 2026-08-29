// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useContextMenuTrigger } from "./use-context-menu-trigger";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

function Fixture() {
  const menu = useContextMenuTrigger();
  return (
    <button
      data-point={menu.point ? `${menu.point.x},${menu.point.y}` : "closed"}
      onContextMenu={menu.openFromPointer}
      onKeyDown={menu.openFromKeyboard}
      type="button"
    >
      Open
    </button>
  );
}

describe("useContextMenuTrigger", () => {
  it("opens from pointer coordinates and the Menu key while retaining the trigger focus", () => {
    act(() => root.render(<Fixture />));
    const trigger = container.querySelector("button");
    if (!trigger) throw new Error("Expected trigger");
    act(() =>
      trigger.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 18, clientY: 29 }),
      ),
    );
    expect(trigger.dataset.point).toBe("18,29");
    expect(document.activeElement).toBe(trigger);
    act(() =>
      trigger.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ContextMenu" })),
    );
    expect(trigger.dataset.point).not.toBe("closed");
    expect(document.activeElement).toBe(trigger);
    act(() =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "F10", shiftKey: true }),
      ),
    );
    expect(trigger.dataset.point).not.toBe("closed");
    expect(document.activeElement).toBe(trigger);
  });
});
