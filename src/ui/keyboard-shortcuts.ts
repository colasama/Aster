/** IME composition must finish before any global shortcut interprets its key events. */
export function isComposingKeyboardEvent(
  event: Pick<KeyboardEvent, "isComposing" | "key">,
): boolean {
  return event.isComposing || event.key === "Process";
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  const closest = (target as { closest?: (selector: string) => Element | null } | null)?.closest;
  return (
    typeof closest === "function" &&
    closest.call(
      target,
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
    ) !== null
  );
}

/** Modal surfaces own their keys, even when a button rather than an input has focus. */
export function isEditorShortcutBlocked(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || isComposingKeyboardEvent(event)) return true;
  const target = event.target as HTMLElement | null;
  const owner = target?.ownerDocument ?? (typeof document !== "undefined" ? document : undefined);
  return Boolean(owner?.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]'));
}
