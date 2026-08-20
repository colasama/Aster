import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type PluginCapability = "gpu_compute" | "gpu_render" | "file_read" | "network";

interface PluginParameterBase {
  name: string;
  label: string;
}

export interface PluginNumberParameter extends PluginParameterBase {
  type: "number";
  default: number;
  min: number;
  max: number;
}

export interface PluginColorParameter extends PluginParameterBase {
  type: "color";
  default: [number, number, number, number];
}

export interface PluginChoiceParameter extends PluginParameterBase {
  type: "choice";
  default: string;
  choices: string[];
}

export interface PluginTextureParameter extends PluginParameterBase {
  type: "texture";
}

export type PluginParameter =
  | PluginNumberParameter
  | PluginColorParameter
  | PluginChoiceParameter
  | PluginTextureParameter;

export interface PluginManifest {
  plugin: {
    id: string;
    name: string;
    version: string;
    api_version: number;
    shader: string;
  };
  capabilities: PluginCapability[];
  parameters: PluginParameter[];
}

export interface PluginStatus {
  directory: string;
  safeMode: boolean;
  disabled: string[];
  report: {
    plugins: PluginManifest[];
    failures: Array<{ manifest: string; message: string }>;
  };
  hotReload: PluginHotReloadStatus;
  native: boolean;
}

export interface PluginHotReloadStatus {
  enabled: boolean;
  suspendedBySafeMode: boolean;
  pending: boolean;
  revision: number;
  successfulReloads: number;
  rejectedReloads: number;
  diagnostics: Array<{
    revision: number;
    plugin: string;
    level: "info" | "error";
    message: string;
  }>;
}

const browserPreferencesKey = "aster.pluginPreferences";

export async function readPluginStatus(): Promise<PluginStatus> {
  if (isTauriRuntime()) {
    const status = await invoke<Omit<PluginStatus, "native">>("plugin_status");
    return { ...status, native: true };
  }
  const preferences = readBrowserPreferences();
  return {
    directory: "Native app data / plugins",
    safeMode: preferences.safeMode,
    disabled: preferences.disabled,
    report: { plugins: [], failures: [] },
    hotReload: emptyHotReloadStatus(),
    native: false,
  };
}

export async function pollPluginHotReload(): Promise<PluginStatus> {
  if (!isTauriRuntime()) return readPluginStatus();
  const status = await invoke<Omit<PluginStatus, "native">>("poll_plugin_hot_reload");
  return { ...status, native: true };
}

export async function installPluginFromFolder(): Promise<PluginStatus | undefined> {
  if (!isTauriRuntime()) {
    throw new Error("Plugin installation is available in the native Aster application");
  }
  const source = await open({
    directory: true,
    multiple: false,
    title: "Select an Aster plugin folder",
  });
  if (!source) return undefined;
  const status = await invoke<Omit<PluginStatus, "native">>("install_plugin", { source });
  return { ...status, native: true };
}

export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginStatus> {
  if (isTauriRuntime()) {
    const status = await invoke<Omit<PluginStatus, "native">>("set_plugin_enabled", {
      pluginId,
      enabled,
    });
    return { ...status, native: true };
  }
  const status = await readPluginStatus();
  status.disabled = enabled
    ? status.disabled.filter((id) => id !== pluginId)
    : [...new Set([...status.disabled, pluginId])];
  writeBrowserPreferences(status);
  return status;
}

export async function setPluginSafeMode(safeMode: boolean): Promise<PluginStatus> {
  if (isTauriRuntime()) {
    const status = await invoke<Omit<PluginStatus, "native">>("set_plugin_safe_mode", { safeMode });
    return { ...status, native: true };
  }
  const status = await readPluginStatus();
  status.safeMode = safeMode;
  writeBrowserPreferences(status);
  return status;
}

export async function setPluginHotReload(enabled: boolean): Promise<PluginStatus> {
  if (isTauriRuntime()) {
    const status = await invoke<Omit<PluginStatus, "native">>("set_plugin_hot_reload", {
      enabled,
    });
    return { ...status, native: true };
  }
  const status = await readPluginStatus();
  status.hotReload.enabled = enabled;
  return status;
}

function emptyHotReloadStatus(): PluginHotReloadStatus {
  return {
    enabled: false,
    suspendedBySafeMode: false,
    pending: false,
    revision: 0,
    successfulReloads: 0,
    rejectedReloads: 0,
    diagnostics: [],
  };
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function readBrowserPreferences(): Pick<PluginStatus, "safeMode" | "disabled"> {
  try {
    const value = JSON.parse(localStorage.getItem(browserPreferencesKey) ?? "{}") as {
      safeMode?: unknown;
      disabled?: unknown;
    };
    return {
      safeMode: value.safeMode === true,
      disabled: Array.isArray(value.disabled)
        ? value.disabled.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return { safeMode: false, disabled: [] };
  }
}

function writeBrowserPreferences(status: Pick<PluginStatus, "safeMode" | "disabled">): void {
  localStorage.setItem(
    browserPreferencesKey,
    JSON.stringify({ safeMode: status.safeMode, disabled: status.disabled }),
  );
}
