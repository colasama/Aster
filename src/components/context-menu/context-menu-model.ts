import type { ReactNode } from "react";

interface ContextMenuItemBase {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  destructive?: boolean;
}

export interface ContextMenuCommand extends ContextMenuItemBase {
  kind: "command";
  onSelect: () => void;
}

export interface ContextMenuCheckbox extends ContextMenuItemBase {
  kind: "checkbox";
  checked: boolean;
  onSelect: () => void;
}

export interface ContextMenuRadio extends ContextMenuItemBase {
  kind: "radio";
  checked: boolean;
  group: string;
  onSelect: () => void;
}

export interface ContextMenuSubmenu extends ContextMenuItemBase {
  kind: "submenu";
  items: ContextMenuItem[];
}

export interface ContextMenuSeparator {
  kind: "separator";
  id: string;
}

export type ContextMenuItem =
  | ContextMenuCommand
  | ContextMenuCheckbox
  | ContextMenuRadio
  | ContextMenuSubmenu
  | ContextMenuSeparator;

export type ContextMenuItemDefinition<Context> =
  | ContextMenuSeparator
  | (Omit<ContextMenuCommand, "disabled" | "onSelect"> & {
      when?: (context: Context) => boolean;
      disabled?: boolean | ((context: Context) => boolean);
      onSelect: (context: Context) => void;
    })
  | (Omit<ContextMenuCheckbox, "checked" | "disabled" | "onSelect"> & {
      when?: (context: Context) => boolean;
      checked: boolean | ((context: Context) => boolean);
      disabled?: boolean | ((context: Context) => boolean);
      onSelect: (context: Context) => void;
    })
  | (Omit<ContextMenuRadio, "checked" | "disabled" | "onSelect"> & {
      when?: (context: Context) => boolean;
      checked: boolean | ((context: Context) => boolean);
      disabled?: boolean | ((context: Context) => boolean);
      onSelect: (context: Context) => void;
    })
  | (Omit<ContextMenuSubmenu, "disabled" | "items"> & {
      when?: (context: Context) => boolean;
      disabled?: boolean | ((context: Context) => boolean);
      items: ContextMenuItemDefinition<Context>[];
    });

export function resolveContextMenu<Context>(
  definitions: readonly ContextMenuItemDefinition<Context>[],
  context: Context,
): ContextMenuItem[] {
  const resolved: ContextMenuItem[] = [];
  for (const definition of definitions) {
    if (definition.kind === "separator") {
      resolved.push(definition);
      continue;
    }
    if (definition.when && !definition.when(context)) continue;
    const disabled = resolveFlag(definition.disabled, context);
    if (definition.kind === "submenu") {
      const items = normalizeSeparators(resolveContextMenu(definition.items, context));
      if (items.length > 0)
        resolved.push({
          id: definition.id,
          kind: "submenu",
          label: definition.label,
          icon: definition.icon,
          shortcut: definition.shortcut,
          destructive: definition.destructive,
          disabled,
          items,
        });
      continue;
    }
    const onSelect = () => definition.onSelect(context);
    if (definition.kind === "command") {
      resolved.push({
        id: definition.id,
        kind: "command",
        label: definition.label,
        icon: definition.icon,
        shortcut: definition.shortcut,
        destructive: definition.destructive,
        disabled,
        onSelect,
      });
      continue;
    }
    const shared = {
      id: definition.id,
      label: definition.label,
      icon: definition.icon,
      shortcut: definition.shortcut,
      destructive: definition.destructive,
      checked: resolveFlag(definition.checked, context),
      disabled,
      onSelect,
    };
    resolved.push(
      definition.kind === "radio"
        ? { ...shared, kind: "radio", group: definition.group }
        : { ...shared, kind: "checkbox" },
    );
  }
  return normalizeSeparators(resolved);
}

export function normalizeSeparators(items: readonly ContextMenuItem[]): ContextMenuItem[] {
  const normalized: ContextMenuItem[] = [];
  for (const item of items) {
    if (item.kind === "separator") {
      if (normalized.length === 0 || normalized[normalized.length - 1]?.kind === "separator")
        continue;
    }
    normalized.push(item);
  }
  if (normalized[normalized.length - 1]?.kind === "separator") normalized.pop();
  return normalized;
}

function resolveFlag<Context>(
  value: boolean | ((context: Context) => boolean) | undefined,
  context: Context,
): boolean {
  return typeof value === "function" ? value(context) : Boolean(value);
}
