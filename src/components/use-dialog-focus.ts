import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface DialogFocusOptions {
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly open?: boolean;
}

/** Keeps keyboard focus inside a modal surface and restores its trigger after close. */
export function useDialogFocus<T extends HTMLElement>({
  initialFocusRef,
  onClose,
  open = true,
}: DialogFocusOptions): RefObject<T | null> {
  const dialogRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const document = dialog.ownerDocument;
    const ownerWindow = document.defaultView;
    const restoreTarget = focusableElement(document.activeElement);
    const initialTarget =
      focusableElement(initialFocusRef?.current) ?? focusableElements(dialog)[0] ?? dialog;
    initialTarget.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      const openDialogs = document.querySelectorAll<HTMLElement>(
        '[role="dialog"][aria-modal="true"]',
      );
      if (openDialogs.item(openDialogs.length - 1) !== dialog) return;
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusableElements(dialog);
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const activeIndex = elements.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? activeIndex <= 0
          ? elements.length - 1
          : activeIndex - 1
        : activeIndex < 0 || activeIndex === elements.length - 1
          ? 0
          : activeIndex + 1;
      event.preventDefault();
      elements[nextIndex]?.focus({ preventScroll: true });
    };

    ownerWindow?.addEventListener("keydown", onKeyDown);
    return () => {
      ownerWindow?.removeEventListener("keydown", onKeyDown);
      if (restoreTarget?.isConnected) restoreTarget.focus({ preventScroll: true });
    };
  }, [initialFocusRef, open]);

  return dialogRef;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      !element.closest("[hidden], [inert], [aria-hidden='true']") &&
      !element.hidden &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.getAttribute("aria-disabled") !== "true",
  );
}

function focusableElement(value: unknown): HTMLElement | undefined {
  if (!value || typeof (value as HTMLElement).focus !== "function") return undefined;
  return value as HTMLElement;
}
