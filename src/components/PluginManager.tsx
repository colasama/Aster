import { AlertTriangle, FolderPlus, Puzzle, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  installPluginFromFolder,
  type PluginStatus,
  readPluginStatus,
  setPluginEnabled,
  setPluginSafeMode,
} from "../core/plugins";

export function PluginManager() {
  const [status, setStatus] = useState<PluginStatus>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const run = useCallback(async (operation: () => Promise<PluginStatus | undefined>) => {
    setPending(true);
    setError(undefined);
    try {
      const next = await operation();
      if (next) setStatus(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Plugin operation failed");
    } finally {
      setPending(false);
    }
  }, []);

  useEffect(() => {
    void run(readPluginStatus);
  }, [run]);

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
      {error && (
        <div className="plugin-error" role="alert">
          <AlertTriangle size={14} /> {error}
        </div>
      )}
      <div className="plugin-list">
        {status?.report.plugins.map((manifest) => {
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
        {status && status.report.plugins.length === 0 && (
          <div className="plugin-empty">
            <Puzzle size={22} />
            <strong>No third-party plugins installed</strong>
            <span className="plugin-empty-copy">
              {status.native
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
    </div>
  );
}
