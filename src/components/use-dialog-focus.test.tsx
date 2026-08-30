// @vitest-environment happy-dom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDialogFocus } from "./use-dialog-focus";

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

describe("useDialogFocus", () => {
  it("traps Tab, closes with Escape, and restores the trigger", () => {
    const closed = vi.fn();
    act(() => root.render(<Harness onClose={closed} />));
    const trigger = button("Open");
    act(() => {
      trigger.focus();
      trigger.click();
    });

    expect(document.activeElement).toBe(container.querySelector("input"));
    act(() => press("Tab", { shiftKey: true }));
    expect(document.activeElement).toBe(button("Done"));
    act(() => press("Tab"));
    expect(document.activeElement).toBe(container.querySelector("input"));
    act(() => press("Escape"));

    expect(closed).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not close while an IME composition is active", () => {
    const closed = vi.fn();
    act(() => root.render(<Harness onClose={closed} />));
    act(() => button("Open").click());
    act(() => press("Escape", { isComposing: true }));
    expect(closed).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open
      </button>
      {open && (
        <Dialog
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function Dialog({ onClose }: { onClose: () => void }) {
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialogFocus<HTMLElement>({ initialFocusRef, onClose });
  return (
    <section aria-modal="true" ref={dialogRef} role="dialog" tabIndex={-1}>
      <input aria-label="Name" ref={initialFocusRef} />
      <button type="button">Done</button>
    </section>
  );
}

function button(name: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  );
  if (!result) throw new Error(`Expected ${name} button`);
  return result;
}

function press(key: string, options: KeyboardEventInit = {}): void {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, key, ...options }),
  );
}
