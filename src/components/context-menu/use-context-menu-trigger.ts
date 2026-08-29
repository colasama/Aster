import { useState } from "react";

export interface ContextMenuPoint {
  x: number;
  y: number;
}

interface FocusableTarget extends Element {
  focus(options?: FocusOptions): void;
}

interface PointerTriggerEvent {
  clientX: number;
  clientY: number;
  currentTarget: FocusableTarget;
  preventDefault(): void;
  stopPropagation(): void;
}

interface KeyboardTriggerEvent {
  currentTarget: FocusableTarget;
  key: string;
  shiftKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export function useContextMenuTrigger() {
  const [point, setPoint] = useState<ContextMenuPoint>();
  const focusAndOpen = (target: FocusableTarget, next: ContextMenuPoint) => {
    target.focus({ preventScroll: true });
    setPoint(next);
  };
  const openFromPointer = (event: PointerTriggerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    focusAndOpen(event.currentTarget, { x: event.clientX, y: event.clientY });
  };
  const openFromKeyboard = (event: KeyboardTriggerEvent): boolean => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return false;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    focusAndOpen(event.currentTarget, {
      x: bounds.left + Math.min(bounds.width / 2, 24),
      y: bounds.top + Math.min(bounds.height / 2, 24),
    });
    return true;
  };
  return {
    close: () => setPoint(undefined),
    openAt: focusAndOpen,
    openFromKeyboard,
    openFromPointer,
    point,
  };
}
