import { invoke, isDesktopRuntime, open } from "../desktop/api";

export const HOST_PLUGIN_API_VERSION = 1;

export type PluginCapability = "gpu_compute" | "gpu_render" | "file_read" | "network";
export type PluginKind = "effect" | "scene_generator";

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

export interface PluginVectorParameter extends PluginParameterBase {
  type: "vector";
  default: number[];
  min: number;
  max: number;
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
  | PluginVectorParameter
  | PluginChoiceParameter
  | PluginTextureParameter;

export interface PluginManifest {
  plugin: {
    id: string;
    name: string;
    version: string;
    api_version: number;
    shader: string;
    kind?: PluginKind;
  };
  capabilities: PluginCapability[];
  parameters: PluginParameter[];
  scene_generator?: SceneGeneratorGraph;
}

export interface SceneGeneratorGraph {
  api_version: number;
  node_type: string;
  capacity_parameter: string;
  max_instances: number;
  instance_stride: number;
  render_parameter?: string;
  compute_passes: SceneGeneratorComputePass[];
  render_variants: SceneGeneratorRenderVariant[];
}

export interface SceneGeneratorComputePass {
  id: string;
  shader: string;
  entry_point: string;
  workgroup_size: [number, number, number];
  phase: "simulation" | "pre_render";
}

export interface SceneGeneratorRenderVariant {
  id: string;
  shader: string;
  vertex_entry: string;
  fragment_entry: string;
  vertex_count: number;
  selector_value?: string;
  blend: "normal" | "add" | "multiply" | "screen" | "overlay" | "layer";
  depth: "none" | "read" | "read_write";
  cull: "none" | "front" | "back";
  auxiliary?: {
    shader: string;
    vertex_entry: string;
    fragment_entry: string;
  };
}

export interface PluginStatus {
  directory: string;
  safeMode: boolean;
  disabled: string[];
  report: {
    plugins: PluginManifest[];
    failures: Array<{ manifest: string; message: string }>;
    shader_sources?: Record<string, Record<string, string>>;
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
  if (isDesktopRuntime()) {
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
  if (!isDesktopRuntime()) return readPluginStatus();
  const status = await invoke<Omit<PluginStatus, "native">>("poll_plugin_hot_reload");
  return { ...status, native: true };
}

export async function installPluginFromFolder(): Promise<PluginStatus | undefined> {
  if (!isDesktopRuntime()) {
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
  if (isDesktopRuntime()) {
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
  if (isDesktopRuntime()) {
    const status = await invoke<Omit<PluginStatus, "native">>("set_plugin_safe_mode", { safeMode });
    return { ...status, native: true };
  }
  const status = await readPluginStatus();
  status.safeMode = safeMode;
  writeBrowserPreferences(status);
  return status;
}

export async function setPluginHotReload(enabled: boolean): Promise<PluginStatus> {
  if (isDesktopRuntime()) {
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
