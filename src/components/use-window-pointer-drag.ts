import { useCallback, useEffect, useMemo, useRef } from "react";

export interface WindowPointerDragCallbacks {
  onCancel?: () => void;
  onCommit: (event: PointerEvent) => void;
  onMove: (event: PointerEvent) => void;
}

export type StartWindowPointerDrag = (
  pointerId: number,
  callbacks: WindowPointerDragCallbacks,
) => void;

interface ActivePointerDrag {
  cancel: (notify?: boolean) => void;
}

interface PointerDragEventTarget {
  addEventListener(type: string, listener: EventListener, capture?: boolean): void;
  removeEventListener(type: string, listener: EventListener, capture?: boolean): void;
}

export function bindWindowPointerDrag(
  target: PointerDragEventTarget,
  pointerId: number,
  callbacks: WindowPointerDragCallbacks,
): (notify?: boolean) => void {
  let running = true;
  const cleanup = () => {
    target.removeEventListener("pointermove", move as EventListener);
    target.removeEventListener("pointerup", commit as EventListener);
    target.removeEventListener("pointercancel", cancelEvent as EventListener);
    target.removeEventListener("blur", cancelBlur);
    target.removeEventListener("keydown", cancelKey as EventListener, true);
  };
  const cancel = (notify = true) => {
    if (!running) return;
    running = false;
    cleanup();
    if (notify) callbacks.onCancel?.();
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId === pointerId) callbacks.onMove(event);
  };
  const commit = (event: PointerEvent) => {
    if (event.pointerId !== pointerId || !running) return;
    running = false;
    cleanup();
    callbacks.onCommit(event);
  };
  const cancelEvent = (event: PointerEvent) => {
    if (event.pointerId === pointerId) cancel();
  };
  const cancelBlur = () => cancel();
  const cancelKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };
  target.addEventListener("pointermove", move as EventListener);
  target.addEventListener("pointerup", commit as EventListener);
  target.addEventListener("pointercancel", cancelEvent as EventListener);
  target.addEventListener("blur", cancelBlur);
  target.addEventListener("keydown", cancelKey as EventListener, true);
  return cancel;
}

/** Owns one timeline pointer transaction and always releases global listeners. */
export function useWindowPointerDrag(): {
  cancel: () => void;
  start: StartWindowPointerDrag;
} {
  const active = useRef<ActivePointerDrag | undefined>(undefined);
  const start = useCallback<StartWindowPointerDrag>((pointerId, callbacks) => {
    active.current?.cancel();
    let controller: ActivePointerDrag;
    const release = () => {
      if (active.current === controller) active.current = undefined;
    };
    controller = {
      cancel: bindWindowPointerDrag(window, pointerId, {
        onMove: callbacks.onMove,
        onCommit: (event) => {
          release();
          callbacks.onCommit(event);
        },
        onCancel: () => {
          release();
          callbacks.onCancel?.();
        },
      }),
    };
    active.current = controller;
  }, []);
  const cancel = useCallback(() => active.current?.cancel(), []);
  useEffect(() => () => active.current?.cancel(false), []);
  return useMemo(() => ({ cancel, start }), [cancel, start]);
}
