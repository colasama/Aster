import { describe, expect, it, vi } from "vitest";
import { bindWindowPointerDrag } from "./use-window-pointer-drag";

describe("window pointer drag lifecycle", () => {
  it("filters pointer identities and commits once", () => {
    const target = new EventTarget();
    const onMove = vi.fn();
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    bindWindowPointerDrag(target, 7, { onMove, onCommit, onCancel });
    target.dispatchEvent(pointerEvent("pointermove", 3));
    target.dispatchEvent(pointerEvent("pointermove", 7));
    target.dispatchEvent(pointerEvent("pointerup", 7));
    target.dispatchEvent(pointerEvent("pointerup", 7));
    expect(onMove).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it.each(["pointercancel", "blur"])("cancels and removes listeners on %s", (type) => {
    const target = new EventTarget();
    const onMove = vi.fn();
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    bindWindowPointerDrag(target, 7, { onMove, onCommit, onCancel });
    target.dispatchEvent(type === "blur" ? new Event(type) : pointerEvent(type, 7));
    target.dispatchEvent(pointerEvent("pointermove", 7));
    target.dispatchEvent(pointerEvent("pointerup", 7));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onMove).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

function pointerEvent(type: string, pointerId: number): Event {
  const event = new Event(type);
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}
