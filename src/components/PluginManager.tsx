import { AlertTriangle, FolderPlus, Puzzle, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type PluginRegistryCatalog, readPluginRegistryCatalog } from "../core/plugin-catalog";
import {
  installPluginFromFolder,
  type PluginStatus,
  pollPluginHotReload,
  readPluginStatus,
  setPluginEnabled,
  setPluginHotReload,
  setPluginSafeMode,
} from "../core/plugins";
import { synchronizePluginEffectDefinitions } from "../effects/plugin-registry";
import { PluginRegistryPreview } from "./PluginRegistryPreview";

type PluginManagerView = "installed" | "registry";

export function PluginManager() {
  const [status, setStatus] = useState<PluginStatus>();
  const [pending, setPending] = useState(false);
  const [installedError, setInstalledError] = useState<string>();
  const [installedQuery, setInstalledQuery] = useState("");
  const [registryQuery, setRegistryQuery] = useState("");
  const [view, setView] = useState<PluginManagerView>("installed");
  const [catalog, setCatalog] = useState<PluginRegistryCatalog>();
  const [catalogError, setCatalogError] = useState<string>();
  const [catalogPending, setCatalogPending] = useState(true);

  const run = useCallback(async (operation: () => Promise<PluginStatus | undefined>) => {
    setPending(true);
    setInstalledError(undefined);
    try {
      const next = await operation();
      if (next) {
        const failures = synchronizePluginEffectDefinitions(next);
        if (failures.length > 0)
          setInstalledError(`Plugin schema rejected: ${failures[0].message}`);
        setStatus(next);
      }
    } catch (reason) {
      setInstalledError(reason instanceof Error ? reason.message : "Plugin operation failed");
    } finally {
      setPending(false);
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    setCatalogPending(true);
    setCatalogError(undefined);
    try {
      setCatalog(await readPluginRegistryCatalog());
    } catch (reason) {
      setCatalogError(reason instanceof Error ? reason.message : "Registry preview failed to load");
    } finally {
      setCatalogPending(false);
    }
  }, []);

  useEffect(() => {
    void run(readPluginStatus);
  }, [run]);
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);
  useEffect(() => {
    if (!status?.native || !status.hotReload.enabled || status.safeMode) return;
    let polling = false;
    const interval = window.setInterval(() => {
      if (polling) return;
      polling = true;
      void pollPluginHotReload()
        .then((next) => {
          synchronizePluginEffectDefinitions(next);
          setStatus(next);
        })
        .catch((reason: unknown) => {
          setInstalledError(
            reason instanceof Error ? reason.message : "Plugin hot reload poll failed",
          );
        })
        .finally(() => {
          polling = false;
        });
    }, 750);
    return () => window.clearInterval(interval);
  }, [status?.hotReload.enabled, status?.native, status?.safeMode]);
  const visiblePlugins = filterPluginManifests(status?.report.plugins ?? [], installedQuery);

  return (
    <div className="plugin-manager">
      <div className="plugin-toolbar">
        <div>
          <strong className="plugin-toolbar-title">WGSL effect plugins</strong>
          <span className="plugin-directory" title={status?.directory}>
            {status?.directory ?? "Loading plugin directory…"}
          </span>
        </div>
        <button disabled={pending} onClick={() => void run(readPluginStatus)} type="button">
          <RefreshCw className={pending ? "spin" : undefined} size={13} /> Refresh
        </button>
        <button
          className="plugin-install-button"
          disabled={pending}
          onClick={() => void run(installPluginFromFolder)}
          type="button"
        >
          <FolderPlus size={13} /> Install folder…
        </button>
      </div>
      <div aria-label="Plugin manager view" className="plugin-view-tabs" role="tablist">
        <button
          aria-selected={view === "installed"}
          className={view === "installed" ? "active" : undefined}
          onClick={() => setView("installed")}
          role="tab"
          type="button"
        >
          Installed {status ? `(${status.report.plugins.length})` : ""}
        </button>
        <button
          aria-selected={view === "registry"}
          className={view === "registry" ? "active" : undefined}
          onClick={() => setView("registry")}
          role="tab"
          type="button"
        >
          Registry preview {catalog ? `(${catalog.packages.length})` : ""}
        </button>
      </div>
      {view === "installed" && (
        <>
          <label className="plugin-safe-mode">
            <input
              checked={status?.safeMode ?? false}
              disabled={pending || !status}
              onChange={(event) => void run(() => setPluginSafeMode(event.target.checked))}
              type="checkbox"
            />
            <ShieldCheck size={15} />
            <span className="plugin-safe-copy">
              <strong className="plugin-safe-title">Safe mode</strong>
              <small className="plugin-metadata">
                Disable every third-party plugin without changing individual settings.
              </small>
            </span>
          </label>
          <label className="plugin-hot-reload">
            <input
              checked={status?.hotReload.enabled ?? false}
              disabled={pending || !status?.native}
              onChange={(event) => void run(() => setPluginHotReload(event.target.checked))}
              type="checkbox"
            />
            <RefreshCw className={status?.hotReload.pending ? "spin" : undefined} size={15} />
            <span className="plugin-safe-copy">
              <strong className="plugin-safe-title">Developer hot reload</strong>
              <small className="plugin-metadata">{describeHotReload(status)}</small>
            </span>
          </label>
          {installedError && (
            <div className="plugin-error" role="alert">
              <AlertTriangle size={14} /> {installedError}
            </div>
          )}
          <label className="plugin-search">
            <Search size={13} />
            <input
              aria-label="Search plugins"
              onChange={(event) => setInstalledQuery(event.target.value)}
              placeholder="Search name, ID, version, or capability"
              type="search"
              value={installedQuery}
            />
            {status && <small>{visiblePlugins.length} found</small>}
          </label>
          <div className="plugin-list">
            {status &&
              visiblePlugins.map((manifest) => {
                const disabled = status.safeMode || status.disabled.includes(manifest.plugin.id);
                return (
                  <article className={disabled ? "disabled" : undefined} key={manifest.plugin.id}>
                    <Puzzle size={18} />
                    <div className="plugin-info">
                      <strong className="plugin-name">{manifest.plugin.name}</strong>
                      <span className="plugin-identity">
                        {manifest.plugin.id} · v{manifest.plugin.version} · API{" "}
                        {manifest.plugin.api_version}
                      </span>
                      <small className="plugin-metadata">
                        {manifest.capabilities.join(" · ") || "No privileged capabilities"} ·{" "}
                        {manifest.parameters.length} parameters
                      </small>
                    </div>
                    <label>
                      <input
                        checked={!disabled}
                        disabled={pending || status.safeMode}
                        onChange={(event) =>
                          void run(() => setPluginEnabled(manifest.plugin.id, event.target.checked))
                        }
                        type="checkbox"
                      />
                      Enabled
                    </label>
                  </article>
                );
              })}
            {status && visiblePlugins.length === 0 && (
              <div className="plugin-empty">
                <Puzzle size={22} />
                <strong>
                  {status.report.plugins.length === 0
                    ? "No third-party plugins installed"
                    : "No plugins match this search"}
                </strong>
                <span className="plugin-empty-copy">
                  {status.report.plugins.length > 0
                    ? "Try a plugin name, reverse-domain ID, version, or declared capability."
                    : status.native
                      ? "Install a folder containing plugin.toml and its declared WGSL shader."
                      : "Open the native Aster app to install and validate local WGSL plugins."}
                </span>
              </div>
            )}
          </div>
          {status && status.report.failures.length > 0 && (
            <details className="plugin-failures" open>
              <summary>
                <AlertTriangle size={13} /> {status.report.failures.length} plugin load failure(s)
              </summary>
              {status.report.failures.map((failure) => (
                <div key={failure.manifest}>
                  <strong>{failure.manifest}</strong>
                  <span>{failure.message}</span>
                </div>
              ))}
            </details>
          )}
          {status && status.hotReload.diagnostics.length > 0 && (
            <details className="plugin-diagnostics">
              <summary>
                Hot reload diagnostics · revision {status.hotReload.revision} ·{" "}
                {status.hotReload.rejectedReloads} rejected
              </summary>
              {status.hotReload.diagnostics.slice(-8).map((diagnostic) => (
                <div
                  className={diagnostic.level}
                  key={`${diagnostic.revision}-${diagnostic.plugin}-${diagnostic.message}`}
                >
                  <strong>{diagnostic.plugin}</strong>
                  <span>{diagnostic.message}</span>
                </div>
              ))}
            </details>
          )}
        </>
      )}
      {view === "registry" && (
        <>
          {catalogError && (
            <div className="plugin-error" role="alert">
              <AlertTriangle size={14} /> {catalogError}
              <button disabled={catalogPending} onClick={() => void loadCatalog()} type="button">
                Retry
              </button>
            </div>
          )}
          <label className="plugin-search">
            <Search size={13} />
            <input
              aria-label="Search registry preview"
              onChange={(event) => setRegistryQuery(event.target.value)}
              placeholder="Search registry name, ID, author, or capability"
              type="search"
              value={registryQuery}
            />
          </label>
          {!catalogError && <PluginRegistryPreview catalog={catalog} query={registryQuery} />}
        </>
      )}
    </div>
  );
}

export function describeHotReload(status: PluginStatus | undefined): string {
  if (!status?.native) return "Available only in the native app.";
  if (!status.hotReload.enabled) return "Off. Enable only while developing trusted local WGSL.";
  if (status.hotReload.suspendedBySafeMode || status.safeMode) {
    return "Suspended while safe mode is active.";
  }
  if (status.hotReload.pending) return "Change detected; waiting for files to settle.";
  return `${status.hotReload.successfulReloads} validated · ${status.hotReload.rejectedReloads} rejected`;
}

export function filterPluginManifests(plugins: PluginStatus["report"]["plugins"], query: string) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return plugins;
  return plugins.filter((manifest) => {
    const searchable = [
      manifest.plugin.name,
      manifest.plugin.id,
      manifest.plugin.version,
      ...manifest.capabilities,
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}
