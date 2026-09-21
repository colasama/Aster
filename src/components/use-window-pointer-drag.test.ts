import { describe, expect, it, vi } from "vitest";
import { bindWindowPointerDrag } from "./use-window-pointer-drag";

describe("window pointer drag lifecycle", () => {
  it("coalesces moves per frame, commits the release position, and discards cancelled moves", () => {
    let pending: FrameRequestCallback | undefined;
    const host = {
      request: (callback: FrameRequestCallback) => {
        pending = callback;
        return 1;
      },
      cancel: () => {
        pending = undefined;
      },
    };
    const target = new EventTarget();
    const onMove = vi.fn();
    const onCommit = vi.fn();
    bindWindowPointerDrag(target, 7, { onMove, onCommit }, host);
    for (let i = 0; i < 100; i++) target.dispatchEvent(pointerEvent("pointermove", 7));
    expect(onMove).not.toHaveBeenCalled();
    pending?.(0);
    expect(onMove).toHaveBeenCalledOnce();
    target.dispatchEvent(pointerEvent("pointermove", 7));
    const release = pointerEvent("pointerup", 7);
    target.dispatchEvent(release);
    expect(onMove).toHaveBeenLastCalledWith(release);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(pending).toBeUndefined();
    const cancel = bindWindowPointerDrag(target, 8, { onMove, onCommit }, host);
    target.dispatchEvent(pointerEvent("pointermove", 8));
    cancel();
    expect(pending).toBeUndefined();
    expect(onMove).toHaveBeenCalledTimes(2);
  });
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
  it("cancels once with Escape before releasing the pointer", () => {
    const target = new EventTarget();
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const onMove = vi.fn();
    bindWindowPointerDrag(target, 7, { onCommit, onCancel, onMove });
    const cancelKey = new Event("keydown", { cancelable: true });
    Object.defineProperty(cancelKey, "key", { value: "Escape" });
    target.dispatchEvent(cancelKey);
    target.dispatchEvent(pointerEvent("pointerup", 7));
    expect(cancelKey.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

function pointerEvent(type: string, pointerId: number): Event {
  const event = new Event(type);
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}
