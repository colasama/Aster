import type { PlainMessageKey } from "../i18n/core";

export interface MenuEntry {
  id: string;
  labelKey: PlainMessageKey;
  shortcut?: string;
}

interface MenuDefinition {
  id: string;
  items: readonly MenuEntry[];
  labelKey: PlainMessageKey;
}

export const menuDefinitions = [
  {
    id: "file",
    labelKey: "topbar.menu.file",
    items: [
      { id: "newProject", labelKey: "topbar.item.newProject" },
      { id: "open", labelKey: "topbar.item.open" },
      { id: "openPacked", labelKey: "topbar.item.openPacked" },
      { id: "recoverAutosave", labelKey: "topbar.item.recoverAutosave" },
      { id: "saveProject", labelKey: "topbar.item.saveProject" },
      { id: "saveAs", labelKey: "topbar.item.saveAs" },
      { id: "packProject", labelKey: "topbar.item.packProject" },
      { id: "exportFrame", labelKey: "topbar.item.exportFrame" },
    ],
  },
  {
    id: "edit",
    labelKey: "topbar.menu.edit",
    items: [
      { id: "undo", labelKey: "topbar.item.undo", shortcut: "Ctrl Z" },
      { id: "redo", labelKey: "topbar.item.redo", shortcut: "Ctrl Y" },
      { id: "duplicate", labelKey: "topbar.item.duplicate" },
      { id: "preferences", labelKey: "topbar.item.preferences" },
    ],
  },
  {
    id: "composition",
    labelKey: "topbar.menu.composition",
    items: [
      { id: "newComposition", labelKey: "topbar.item.newComposition" },
      { id: "compositionSettings", labelKey: "topbar.item.compositionSettings" },
      { id: "renderQueue", labelKey: "topbar.item.renderQueue" },
    ],
  },
  {
    id: "layer",
    labelKey: "topbar.menu.layer",
    items: [
      { id: "importImage", labelKey: "topbar.item.importImage" },
      { id: "importVideo", labelKey: "topbar.item.importVideo" },
      { id: "importMesh", labelKey: "topbar.item.importMesh" },
      { id: "newText", labelKey: "topbar.item.newText" },
      { id: "newShape", labelKey: "topbar.item.newShape" },
      { id: "newMesh", labelKey: "topbar.item.newMesh" },
      { id: "newCamera", labelKey: "topbar.item.newCamera" },
      { id: "newLight", labelKey: "topbar.item.newLight" },
      { id: "newParticles", labelKey: "topbar.item.newParticles" },
      { id: "precompose", labelKey: "topbar.item.precompose" },
    ],
  },
  {
    id: "effect",
    labelKey: "topbar.menu.effect",
    items: [
      { id: "glow", labelKey: "topbar.item.glow" },
      { id: "blur", labelKey: "topbar.item.blur" },
      { id: "colorMatrix", labelKey: "topbar.item.colorMatrix" },
      { id: "looks", labelKey: "topbar.item.looks" },
    ],
  },
  {
    id: "animation",
    labelKey: "topbar.menu.animation",
    items: [
      { id: "addKeyframe", labelKey: "topbar.item.addKeyframe" },
      { id: "graphEditor", labelKey: "topbar.item.graphEditor" },
      { id: "easyEase", labelKey: "topbar.item.easyEase" },
      { id: "expressionEditor", labelKey: "topbar.item.expressionEditor" },
    ],
  },
  {
    id: "view",
    labelKey: "topbar.menu.view",
    items: [
      { id: "fitComposition", labelKey: "topbar.item.fitComposition" },
      { id: "zoomIn", labelKey: "topbar.item.zoomIn" },
      { id: "zoomOut", labelKey: "topbar.item.zoomOut" },
      { id: "toggleGuides", labelKey: "topbar.item.toggleGuides" },
    ],
  },
  {
    id: "window",
    labelKey: "topbar.menu.window",
    items: [
      { id: "project", labelKey: "topbar.item.project" },
      { id: "viewport", labelKey: "topbar.item.viewport" },
      { id: "timeline", labelKey: "topbar.item.timeline" },
      { id: "properties", labelKey: "topbar.item.properties" },
      { id: "aiOperator", labelKey: "topbar.item.aiOperator" },
      { id: "plugins", labelKey: "topbar.item.plugins" },
    ],
  },
  {
    id: "help",
    labelKey: "topbar.menu.help",
    items: [
      { id: "commandPalette", labelKey: "topbar.item.commandPalette", shortcut: "Ctrl K" },
      { id: "keyboardShortcuts", labelKey: "topbar.item.keyboardShortcuts" },
      { id: "gpuDiagnostics", labelKey: "topbar.item.gpuDiagnostics" },
      { id: "exportDiagnostics", labelKey: "topbar.item.exportDiagnostics" },
      { id: "about", labelKey: "topbar.item.about" },
    ],
  },
] as const satisfies readonly MenuDefinition[];

export type MenuId = (typeof menuDefinitions)[number]["id"];
export type MenuItemId = (typeof menuDefinitions)[number]["items"][number]["id"];

export function findMenuEntry(id: MenuItemId): MenuEntry | undefined {
  for (const menu of menuDefinitions) {
    for (const item of menu.items) {
      if (item.id === id) return item;
    }
  }
  return undefined;
}
