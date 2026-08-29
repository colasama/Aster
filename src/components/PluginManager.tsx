import { AlertTriangle, FolderPlus, Puzzle, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type PluginRegistryCatalog, readPluginRegistryCatalog } from "../core/plugin-catalog";
import {
  activatePluginRuntimes,
  getLoadedPluginIds,
  reconcilePluginRuntimes,
  subscribeLoadedPluginIds,
} from "../core/plugin-runtime";
import {
  installPluginFromFolder,
  type PluginStatus,
  pollPluginHotReload,
  readPluginStatus,
  setPluginEnabled,
  setPluginHotReload,
  setPluginSafeMode,
} from "../core/plugins";
import { reportUiError } from "../errors/report-ui-error";
import type { Translate } from "../i18n/core";
import { createTranslator } from "../i18n/core";
import { type UiErrorCode, uiErrorMessage } from "../i18n/errors";
import { useI18n } from "../i18n/react";
import { PluginRegistryPreview } from "./PluginRegistryPreview";

type PluginManagerView = "installed" | "registry";

export class PluginStatusCoordinator {
  private generation = 0;
  private manualPending = false;
  private pollPending = false;

  beginManual(): number {
    this.manualPending = true;
    this.generation += 1;
    return this.generation;
  }

  canCommitManual(token: number): boolean {
    return token === this.generation;
  }

  finishManual(token: number): boolean {
    if (!this.canCommitManual(token)) return false;
    this.manualPending = false;
    return true;
  }

  beginPoll(): number | undefined {
    if (this.manualPending || this.pollPending) return undefined;
    this.pollPending = true;
    return this.generation;
  }

  canCommitPoll(token: number): boolean {
    return !this.manualPending && token === this.generation;
  }

  finishPoll(): void {
    this.pollPending = false;
  }

  invalidate(): void {
    this.generation += 1;
    this.manualPending = false;
    this.pollPending = false;
  }
}

export function PluginManager() {
  const { t } = useI18n();
  const [status, setStatus] = useState<PluginStatus>();
  const [pending, setPending] = useState(false);
  const [installedError, setInstalledError] = useState<UiErrorCode>();
  const [installedQuery, setInstalledQuery] = useState("");
  const [registryQuery, setRegistryQuery] = useState("");
  const [view, setView] = useState<PluginManagerView>("installed");
  const [catalog, setCatalog] = useState<PluginRegistryCatalog>();
  const [catalogError, setCatalogError] = useState<UiErrorCode>();
  const [catalogPending, setCatalogPending] = useState(true);
  const loadedPluginIds = useSyncExternalStore(
    subscribeLoadedPluginIds,
    getLoadedPluginIds,
    getLoadedPluginIds,
  );
  const coordinatorRef = useRef<PluginStatusCoordinator>(new PluginStatusCoordinator());

  const commitStatus = useCallback((next: PluginStatus) => {
    setInstalledError(undefined);
    setStatus(next);
  }, []);

  const run = useCallback(
    async (operation: () => Promise<PluginStatus | undefined>, reconcile = true) => {
      const coordinator = coordinatorRef.current;
      const token = coordinator.beginManual();
      setPending(true);
      setInstalledError(undefined);
      try {
        const next = await operation();
        if (next && reconcile) await reconcilePluginRuntimes(next);
        if (next && coordinator.canCommitManual(token)) commitStatus(next);
      } catch (error) {
        if (coordinator.canCommitManual(token)) {
          setInstalledError("pluginOperation");
          reportUiError(t, "pluginOperation", error, { scope: { area: "application" } });
        }
      } finally {
        if (coordinator.finishManual(token)) setPending(false);
      }
    },
    [commitStatus, t],
  );

  const loadCatalog = useCallback(async () => {
    setCatalogPending(true);
    setCatalogError(undefined);
    try {
      setCatalog(await readPluginRegistryCatalog());
    } catch (error) {
      setCatalogError("pluginCatalog");
      reportUiError(t, "pluginCatalog", error, { scope: { area: "application" } });
    } finally {
      setCatalogPending(false);
    }
  }, [t]);

  useEffect(() => {
    void run(readPluginStatus);
  }, [run]);
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);
  useEffect(() => () => coordinatorRef.current.invalidate(), []);
  useEffect(() => {
    if (!status?.native || !status.hotReload.enabled || status.safeMode) return;
    const interval = window.setInterval(() => {
      const coordinator = coordinatorRef.current;
      const token = coordinator.beginPoll();
      if (token === undefined) return;
      void pollPluginHotReload()
        .then(async (next) => {
          await reconcilePluginRuntimes(next);
          if (coordinator.canCommitPoll(token)) commitStatus(next);
        })
        .catch(() => {
          if (coordinator.canCommitPoll(token)) setInstalledError("pluginOperation");
        })
        .finally(() => {
          coordinator.finishPoll();
        });
    }, 750);
    return () => window.clearInterval(interval);
  }, [commitStatus, status?.hotReload.enabled, status?.native, status?.safeMode]);
  const visiblePlugins = filterPluginManifests(status?.report.plugins ?? [], installedQuery);

  return (
    <div className="plugin-manager">
      <div className="plugin-toolbar">
        <div>
          <strong className="plugin-toolbar-title">{t("plugin.title")}</strong>
          <span className="plugin-directory" title={status?.directory}>
            {status?.directory ?? t("plugin.loadingDirectory")}
          </span>
        </div>
        <button disabled={pending} onClick={() => void run(readPluginStatus)} type="button">
          <RefreshCw className={pending ? "spin" : undefined} size={13} /> {t("plugin.refresh")}
        </button>
        <button
          className="plugin-install-button"
          disabled={pending}
          onClick={() => void run(installPluginFromFolder)}
          type="button"
        >
          <FolderPlus size={13} /> {t("plugin.installFolder")}
        </button>
      </div>
      <div aria-label={t("plugin.view")} className="plugin-view-tabs" role="tablist">
        <button
          aria-selected={view === "installed"}
          className={view === "installed" ? "active" : undefined}
          onClick={() => setView("installed")}
          role="tab"
          type="button"
        >
          {t("plugin.installed")} {status ? `(${status.report.plugins.length})` : ""}
        </button>
        <button
          aria-selected={view === "registry"}
          className={view === "registry" ? "active" : undefined}
          onClick={() => setView("registry")}
          role="tab"
          type="button"
        >
          {t("plugin.registryPreview")} {catalog ? `(${catalog.packages.length})` : ""}
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
              <strong className="plugin-safe-title">{t("plugin.safeMode")}</strong>
              <small className="plugin-metadata">{t("plugin.safeModeHint")}</small>
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
              <strong className="plugin-safe-title">{t("plugin.hotReload")}</strong>
              <small className="plugin-metadata">{describeHotReload(status, t)}</small>
            </span>
          </label>
          {installedError && (
            <div className="plugin-error" role="alert">
              <AlertTriangle size={14} /> {uiErrorMessage(t, installedError)}
            </div>
          )}
          <label className="plugin-search">
            <Search size={13} />
            <input
              aria-label={t("plugin.search")}
              onChange={(event) => setInstalledQuery(event.target.value)}
              placeholder={t("plugin.searchPlaceholder")}
              type="search"
              value={installedQuery}
            />
            {status && <small>{t("plugin.found", { count: visiblePlugins.length })}</small>}
          </label>
          <div className="plugin-list">
            {status &&
              visiblePlugins.map((manifest) => {
                const disabled = status.safeMode || status.disabled.includes(manifest.plugin.id);
                const loaded = loadedPluginIds.has(manifest.plugin.id);
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
                        {manifest.capabilities.join(" · ") || t("plugin.noCapabilities")} ·{" "}
                        {t("plugin.parameterCount", { count: manifest.parameters.length })}
                      </small>
                    </div>
                    <button
                      className="plugin-load-button"
                      disabled={pending || disabled || loaded}
                      onClick={() =>
                        void run(async () => {
                          const next = await activatePluginRuntimes([manifest.plugin.id]);
                          return next ?? status;
                        }, false)
                      }
                      type="button"
                    >
                      {loaded ? t("plugin.runtimeLoaded") : t("plugin.loadRuntime")}
                    </button>
                    <label>
                      <input
                        checked={!disabled}
                        disabled={pending || status.safeMode}
                        onChange={(event) =>
                          void run(() => setPluginEnabled(manifest.plugin.id, event.target.checked))
                        }
                        type="checkbox"
                      />
                      {t("common.enabled")}
                    </label>
                  </article>
                );
              })}
            {status && visiblePlugins.length === 0 && (
              <div className="plugin-empty">
                <Puzzle size={22} />
                <strong>
                  {status.report.plugins.length === 0
                    ? t("plugin.emptyInstalled")
                    : t("plugin.emptySearch")}
                </strong>
                <span className="plugin-empty-copy">
                  {status.report.plugins.length > 0
                    ? t("plugin.emptySearchHint")
                    : status.native
                      ? t("plugin.emptyNativeHint")
                      : t("plugin.emptyBrowserHint")}
                </span>
              </div>
            )}
          </div>
          {status && status.report.failures.length > 0 && (
            <details className="plugin-failures" open>
              <summary>
                <AlertTriangle size={13} />{" "}
                {t("plugin.failureCount", { count: status.report.failures.length })}
              </summary>
              {status.report.failures.map((failure) => (
                <div key={failure.manifest}>
                  <strong>{failure.manifest}</strong>
                  <span>{t("plugin.failureDetail")}</span>
                </div>
              ))}
            </details>
          )}
          {status && status.hotReload.diagnostics.length > 0 && (
            <details className="plugin-diagnostics">
              <summary>
                {t("plugin.diagnostics", {
                  revision: status.hotReload.revision,
                  rejected: status.hotReload.rejectedReloads,
                })}
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
              <AlertTriangle size={14} /> {uiErrorMessage(t, catalogError)}
              <button disabled={catalogPending} onClick={() => void loadCatalog()} type="button">
                {t("plugin.retry")}
              </button>
            </div>
          )}
          <label className="plugin-search">
            <Search size={13} />
            <input
              aria-label={t("plugin.registrySearch")}
              onChange={(event) => setRegistryQuery(event.target.value)}
              placeholder={t("plugin.registrySearchPlaceholder")}
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

export function describeHotReload(
  status: PluginStatus | undefined,
  t: Translate = createTranslator("en-US"),
): string {
  if (!status?.native) return t("plugin.hotReload.nativeOnly");
  if (!status.hotReload.enabled) return t("plugin.hotReload.off");
  if (status.hotReload.suspendedBySafeMode || status.safeMode) {
    return t("plugin.hotReload.suspended");
  }
  if (status.hotReload.pending) return t("plugin.hotReload.pending");
  return t("plugin.hotReload.counts", {
    validated: status.hotReload.successfulReloads,
    rejected: status.hotReload.rejectedReloads,
  });
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
