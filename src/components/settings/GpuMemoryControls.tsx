import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  automaticGpuMemoryBudget,
  type GpuMemoryBudgetMb,
  MIN_MANUAL_GPU_MEMORY_MB,
} from "../../core/rendering/gpu-memory-policy";
import {
  currentGpuMemory,
  detectGpuMemory,
  GPU_MEMORY_CHANGED_EVENT,
} from "../../desktop/gpu-memory";
import { useI18n } from "../../i18n/react";

interface Props {
  value: GpuMemoryBudgetMb;
  onChange(value: GpuMemoryBudgetMb): void;
  onValidityChange(valid: boolean): void;
}

export function GpuMemoryControls({ value, onChange, onValidityChange }: Props) {
  const { t } = useI18n();
  const [memory, setMemory] = useState(currentGpuMemory);
  const [loading, setLoading] = useState(!memory);
  const [text, setText] = useState(value === "auto" ? "" : String(value));
  const device = memory?.device;
  const automatic = automaticGpuMemoryBudget(device);
  const amount = Number(text);
  const valid =
    value === "auto" ||
    (!loading &&
      device !== undefined &&
      text.trim() !== "" &&
      Number.isSafeInteger(amount) &&
      amount >= MIN_MANUAL_GPU_MEMORY_MB &&
      amount <= device.totalMb);

  useEffect(() => {
    setText(value === "auto" ? "" : String(value));
  }, [value]);
  useEffect(() => {
    onValidityChange(valid);
  }, [onValidityChange, valid]);
  useEffect(() => {
    const cached = currentGpuMemory();
    if (cached) {
      setMemory(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void detectGpuMemory().then((next) => {
      if (cancelled) return;
      setMemory(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = async () => {
    setLoading(true);
    const next = await detectGpuMemory();
    setMemory(next);
    setLoading(false);
    window.dispatchEvent(new Event(GPU_MEMORY_CHANGED_EVENT));
  };

  return (
    <>
      <label className="wide">
        {t("workspace.preferences.gpuBudget")}
        <select
          value={value === "auto" ? "auto" : "manual"}
          onChange={(event) =>
            onChange(
              event.target.value === "auto"
                ? "auto"
                : Math.max(MIN_MANUAL_GPU_MEMORY_MB, automatic),
            )
          }
        >
          <option value="auto">
            {t("workspace.preferences.autoBudget")} · {automatic} MiB
          </option>
          <option
            value="manual"
            disabled={loading || !device || device.totalMb < MIN_MANUAL_GPU_MEMORY_MB}
          >
            {t("workspace.preferences.manualBudget")}
          </option>
        </select>
      </label>
      <div className="dialog-note wide gpu-memory-status" aria-live="polite">
        <span>
          {device?.name ?? t("workspace.preferences.gpuUnknown")} ·{" "}
          {t(
            device?.kind === "unified"
              ? "workspace.preferences.gpuUnifiedTotal"
              : "workspace.preferences.gpuTotal",
          )}
          : {device ? `${device.totalMb} MiB` : "—"} · {t("workspace.preferences.gpuFree")}:{" "}
          {device?.freeMb !== undefined ? `${device.freeMb} MiB` : "—"}
        </span>
        <button
          className="control-button"
          type="button"
          disabled={loading}
          onClick={() => void refresh()}
          aria-label={t("workspace.preferences.refreshGpuMemory")}
          title={t("workspace.preferences.refreshGpuMemory")}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {value !== "auto" && (
        <label className="wide">
          {t("workspace.preferences.manualBudget")} (MiB)
          <input
            type="number"
            min={MIN_MANUAL_GPU_MEMORY_MB}
            max={device?.totalMb}
            step={1}
            value={text}
            disabled={loading || !device}
            aria-invalid={!valid}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setText(next);
              const number = Number(next);
              if (
                next.trim() &&
                Number.isSafeInteger(number) &&
                number >= MIN_MANUAL_GPU_MEMORY_MB &&
                device &&
                number <= device.totalMb
              )
                onChange(number);
            }}
          />
        </label>
      )}
      {!loading &&
        (device?.freeMb === undefined ||
          (value !== "auto" && (!valid || amount > (device?.freeMb ?? 0)))) && (
          <div className="dialog-note wide" role="status">
            {device?.freeMb === undefined
              ? t("workspace.preferences.gpuMemoryUnavailable")
              : !valid
                ? t("workspace.preferences.gpuBudgetInvalid", { max: device.totalMb })
                : t("workspace.preferences.gpuBudgetExceedsFree")}
          </div>
        )}
    </>
  );
}
