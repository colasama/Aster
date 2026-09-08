import { useEffect, useRef, useState } from "react";
import type { AutomationSettings, AutomationSettingsApi } from "../desktop/automation-settings";
import { useI18n } from "../i18n/react";

export function AutomationSettingsPanel({ api }: { api: AutomationSettingsApi }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<AutomationSettings>();
  const [port, setPort] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<"configuration">();
  const busy = useRef(false);
  const version = useRef(0);
  const mounted = useRef(true);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    let reading = false;
    let initialized = false;
    const refresh = async () => {
      if (busy.current || reading) return;
      reading = true;
      const currentVersion = version.current;
      try {
        const next = await api.get();
        if (mounted.current && !busy.current && currentVersion === version.current) {
          setSettings(next);
          if (!initialized) {
            setPort(String(next.port));
            setError("");
            initialized = true;
          }
        }
      } catch (cause) {
        if (mounted.current) setError(String(cause));
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      clearTimeout(copyTimer.current);
    };
  }, [api]);

  const update = async (patch: Parameters<AutomationSettingsApi["update"]>[0]) => {
    if (busy.current) return;
    busy.current = true;
    version.current += 1;
    setPending(true);
    setError("");
    setCopied(undefined);
    try {
      const next = await api.update(patch);
      if (mounted.current) {
        setSettings(next);
        setPort(String(next.port));
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      const next = await api.get().catch(() => undefined);
      if (mounted.current && next) setSettings(next);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const copy = async (kind: "configuration") => {
    try {
      await api.copy(kind);
      if (!mounted.current) return;
      setError("");
      setCopied(kind);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(undefined), 2_000);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const disabled = !settings || pending || settings.environmentManaged;
  const validPort = /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  return (
    <fieldset className="automation-settings wide" aria-busy={pending}>
      <legend>MCP</legend>
      <div className="automation-settings-row">
        <label className="dialog-check">
          <input
            type="checkbox"
            checked={settings?.enabled ?? false}
            disabled={disabled}
            onChange={(event) => void update({ enabled: event.target.checked })}
          />
          {t("workspace.mcp.enable")}
        </label>
        <span className="automation-status" data-running={settings?.running ?? false} role="status">
          {!settings
            ? t("workspace.mcp.loading")
            : pending
              ? t("workspace.mcp.applying")
              : settings.running
                ? t(settings.busy ? "workspace.mcp.busy" : "workspace.mcp.listening", {
                    count: settings.clients,
                  })
                : t(settings.error ? "workspace.mcp.failed" : "workspace.mcp.stopped")}
        </span>
      </div>
      {settings?.environmentManaged && (
        <div className="automation-managed">{t("workspace.mcp.environment")}</div>
      )}
      <div className="automation-settings-row">
        <label className="automation-port">
          {t("workspace.mcp.port")}
          <input
            type="number"
            min={1}
            max={65535}
            step={1}
            value={port}
            disabled={disabled}
            aria-invalid={!!port && !validPort}
            onChange={(event) => setPort(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && validPort) {
                event.preventDefault();
                void update({ port: Number(port) });
              }
            }}
          />
        </label>
        <button
          type="button"
          disabled={disabled || !validPort || Number(port) === settings?.port}
          onClick={() => void update({ port: Number(port) })}
        >
          {t("workspace.mcp.applyPort")}
        </button>
      </div>
      <button
        type="button"
        disabled={!settings || pending}
        onClick={() => void copy("configuration")}
      >
        {t(copied === "configuration" ? "workspace.mcp.copied" : "workspace.mcp.copyConfig")}
      </button>
      {(error || settings?.error) && (
        <div className="automation-error" role="alert">
          {error || settings?.error}
        </div>
      )}
      <span className="sr-only" role="status">
        {copied ? t("workspace.mcp.copied") : ""}
      </span>
    </fieldset>
  );
}
