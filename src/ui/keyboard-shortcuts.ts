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
