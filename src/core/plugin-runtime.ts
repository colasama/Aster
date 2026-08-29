import { synchronizePluginEffectDefinitions } from "../effects/plugin-registry";
import { loadPluginRuntime, type PluginStatus } from "./plugins";
import { synchronizeSceneGeneratorDefinitions } from "./scene-generator-registry";

type Listener = () => void;

const manualPluginIds = new Set<string>();
let projectPluginIds = new Set<string>();
let loadedPluginIds = new Set<string>();
const listeners = new Set<Listener>();
let synchronization: Promise<PluginStatus | undefined> = Promise.resolve(undefined);
let requestedKey = "";

export function getLoadedPluginIds(): ReadonlySet<string> {
  return loadedPluginIds;
}

export function subscribeLoadedPluginIds(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function activatePluginRuntimes(
  pluginIds: readonly string[],
): Promise<PluginStatus | undefined> {
  for (const pluginId of pluginIds) manualPluginIds.add(pluginId);
  return scheduleSynchronization();
}

export function setProjectPluginRuntimes(
  pluginIds: readonly string[],
): Promise<PluginStatus | undefined> {
  projectPluginIds = new Set(pluginIds);
  return scheduleSynchronization();
}

export function reconcilePluginRuntimes(status: PluginStatus): Promise<PluginStatus | undefined> {
  const installed = new Set(status.report.plugins.map((manifest) => manifest.plugin.id));
  for (const pluginId of manualPluginIds) {
    if (!installed.has(pluginId)) manualPluginIds.delete(pluginId);
  }
  return scheduleSynchronization(true);
}

function scheduleSynchronization(force = false): Promise<PluginStatus | undefined> {
  const requested = new Set([...manualPluginIds, ...projectPluginIds]);
  const key = [...requested].sort().join("\u0000");
  if (!force && key === requestedKey) return synchronization;
  requestedKey = key;
  const synchronize = async () => {
    if (requested.size === 0) {
      updateLoadedPluginIds(new Set());
      synchronizePluginEffectDefinitions(emptyStatus());
      synchronizeSceneGeneratorDefinitions(emptyStatus());
      return undefined;
    }
    const status = await loadPluginRuntime([...requested]);
    const sources = status.report.shader_sources ?? {};
    const loadedManifests = status.report.plugins.filter(
      (manifest) => requested.has(manifest.plugin.id) && sources[manifest.plugin.id] !== undefined,
    );
    const runtimeStatus: PluginStatus = {
      ...status,
      report: { ...status.report, plugins: loadedManifests, shader_sources: sources },
    };
    const failures = [
      ...synchronizePluginEffectDefinitions(runtimeStatus),
      ...synchronizeSceneGeneratorDefinitions(runtimeStatus),
    ];
    if (failures.length > 0) {
      throw new Error(
        `Plugin runtime activation failed: ${failures.map((failure) => failure.message).join("; ")}`,
      );
    }
    updateLoadedPluginIds(new Set(loadedManifests.map((manifest) => manifest.plugin.id)));
    return status;
  };
  synchronization = synchronization.then(synchronize, synchronize);
  return synchronization;
}

function updateLoadedPluginIds(next: Set<string>): void {
  if (sameSet(loadedPluginIds, next)) return;
  loadedPluginIds = next;
  for (const listener of listeners) listener();
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function emptyStatus(): PluginStatus {
  return {
    directory: "",
    safeMode: false,
    disabled: [],
    report: { plugins: [], failures: [], shader_sources: {} },
    hotReload: {
      enabled: false,
      suspendedBySafeMode: false,
      pending: false,
      revision: 0,
      successfulReloads: 0,
      rejectedReloads: 0,
      diagnostics: [],
    },
    native: false,
  };
}
