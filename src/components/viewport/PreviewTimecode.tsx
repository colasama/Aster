import { useRef, useState } from "react";
import type { Composition } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { formatTimecode, parsePreviewTimecode } from "../../ui/preview-timecode";

export function PreviewTimecode({
  composition,
  time,
  onSeek,
  disabled,
}: {
  composition: Composition;
  time: number;
  onSeek(time: number): void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string>();
  const [invalid, setInvalid] = useState(false);
  const skipBlur = useRef(false);
  const reset = () => {
    setDraft(undefined);
    setInvalid(false);
  };
  const commit = () => {
    if (draft === undefined) return true;
    const parsed = parsePreviewTimecode(draft, composition.frameRate);
    if (parsed === undefined || !Number.isFinite(parsed)) {
      setInvalid(true);
      return false;
    }
    const fps = composition.frameRate.numerator / composition.frameRate.denominator;
    const lastFrame = Math.max(0, Math.ceil(composition.duration * fps) - 1);
    onSeek(Math.min(lastFrame / fps, Math.max(0, parsed)));
    reset();
    return true;
  };
  return (
    <input
      className="preview-timecode"
      aria-label={t("viewport.timecode")}
      aria-invalid={invalid}
      disabled={disabled}
      title={invalid ? t("viewport.timecode.invalid") : t("viewport.timecode.hint")}
      value={draft ?? formatTimecode(time, composition.frameRate)}
      onFocus={(event) => {
        setDraft(event.currentTarget.value);
        event.currentTarget.select();
      }}
      onChange={(event) => {
        setDraft(event.target.value);
        setInvalid(false);
      }}
      onBlur={() => {
        if (skipBlur.current) {
          skipBlur.current = false;
          return;
        }
        if (!commit()) reset();
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          if (commit()) {
            skipBlur.current = true;
            event.currentTarget.blur();
          }
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          reset();
        }
      }}
    />
  );
}
