import { Trash2 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  isFrameCacheBudget,
  MAX_FRAME_CACHE_BUDGET_MB,
} from "../../core/rendering/frame-cache-policy";
import { previewFrameCache } from "../../core/rendering/preview-frame-cache";
import { useI18n } from "../../i18n/react";

interface Props {
  value: number;
  onChange(value: number): void;
  onValidityChange(valid: boolean): void;
}

const MIB = 1024 * 1024;

export function FrameCacheControls({ value, onChange, onValidityChange }: Props) {
  const { t } = useI18n();
  const [text, setText] = useState(String(value));
  const amount = Number(text);
  const valid = text.trim() !== "" && isFrameCacheBudget(amount);
  useSyncExternalStore(
    (listener) => previewFrameCache.subscribe(listener),
    () => previewFrameCache.revision,
  );
  const usage = previewFrameCache.usage();

  useEffect(() => {
    setText(String(value));
  }, [value]);
  useEffect(() => {
    onValidityChange(valid);
  }, [onValidityChange, valid]);

  return (
    <>
      <label className="wide">
        {t("workspace.preferences.frameCacheBudget")}
        <input
          type="number"
          min={0}
          max={MAX_FRAME_CACHE_BUDGET_MB}
          step={256}
          value={text}
          aria-invalid={!valid}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setText(next);
            const number = Number(next);
            if (next.trim() && isFrameCacheBudget(number)) onChange(number);
          }}
        />
      </label>
      <div className="dialog-note wide gpu-memory-status" aria-live="polite">
        <span>
          {t("workspace.preferences.frameCacheUsage", {
            used: Math.round(usage.usedBytes / MIB),
            frames: usage.frameCount,
          })}
        </span>
        <button
          className="control-button"
          type="button"
          disabled={usage.frameCount === 0}
          onClick={() => previewFrameCache.clear()}
          aria-label={t("workspace.preferences.frameCacheClear")}
          title={t("workspace.preferences.frameCacheClear")}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {!valid && (
        <div className="dialog-note wide" role="status">
          {t("workspace.preferences.frameCacheBudgetInvalid", { max: MAX_FRAME_CACHE_BUDGET_MB })}
        </div>
      )}
    </>
  );
}
