import {
  type MessageDescriptor,
  type MessageKey,
  messageDescriptor,
  type PlainMessageKey,
  type Translate,
  type TranslationArguments,
  translateDescriptor,
} from "./core";

export type UiErrorCode =
  | "aiRequest"
  | "assetImageImport"
  | "assetRelink"
  | "assetVideoImport"
  | "backgroundRender"
  | "diagnosticsExport"
  | "expression"
  | "frameExport"
  | "hdrImport"
  | "lutImport"
  | "mediaImport"
  | "meshImport"
  | "pluginCatalog"
  | "pluginOperation"
  | "presetSave"
  | "projectOpen"
  | "projectPack"
  | "projectPackedOpen"
  | "projectRecovery"
  | "projectSave";

const errorKeys: Record<UiErrorCode, PlainMessageKey> = {
  aiRequest: "ui.error.aiRequest",
  assetImageImport: "ui.error.assetImageImport",
  assetRelink: "ui.error.assetRelink",
  assetVideoImport: "ui.error.assetVideoImport",
  backgroundRender: "ui.error.backgroundRender",
  diagnosticsExport: "ui.error.diagnosticsExport",
  expression: "ui.error.expression",
  frameExport: "ui.error.frameExport",
  hdrImport: "ui.error.hdrImport",
  lutImport: "ui.error.lutImport",
  mediaImport: "ui.error.mediaImport",
  meshImport: "ui.error.meshImport",
  pluginCatalog: "ui.error.pluginCatalog",
  pluginOperation: "ui.error.pluginOperation",
  presetSave: "ui.error.presetSave",
  projectOpen: "ui.error.projectOpen",
  projectPack: "ui.error.projectPack",
  projectPackedOpen: "ui.error.projectPackedOpen",
  projectRecovery: "ui.error.projectRecovery",
  projectSave: "ui.error.projectSave",
};

export function uiErrorMessage(t: Translate, code: UiErrorCode): string {
  return t(errorKeys[code]);
}

export type UiMessageDescriptor =
  | { kind: "error"; code: UiErrorCode }
  | { kind: "message"; message: MessageDescriptor };

export function uiError(code: UiErrorCode): UiMessageDescriptor {
  return { kind: "error", code };
}

export function uiMessage<Key extends MessageKey>(
  key: Key,
  ...values: TranslationArguments<Key>
): UiMessageDescriptor {
  return { kind: "message", message: messageDescriptor(key, ...values) };
}

export function translateUiMessage(t: Translate, descriptor: UiMessageDescriptor): string {
  return descriptor.kind === "error"
    ? uiErrorMessage(t, descriptor.code)
    : translateDescriptor(t, descriptor.message);
}
