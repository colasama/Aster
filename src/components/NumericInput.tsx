import { type InputHTMLAttributes, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/react";
import { RafCoalescer } from "../workspace/raf-coalescer";
import { bindWindowPointerDrag } from "./use-window-pointer-drag";

export type NumericEditPhase = "preview" | "commit" | "cancel";
type NumericInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "min" | "max" | "step" | "type"
> & {
  value: number;
  editTime?: number;
  min?: number;
  max?: number;
  step?: number;
  type?: "number" | "range";
  onValueChange: (value: number, phase: NumericEditPhase) => void;
};

export function NumericInput({
  value,
  editTime,
  min = -Infinity,
  max = Infinity,
  step = 1,
  type = "number",
  onValueChange,
  onKeyDown,
  className = "",
  ...props
}: NumericInputProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const active = useRef<{ move: (value: number) => void; cancel: () => void } | undefined>(
    undefined,
  );
  const normalize = (next: number) => Math.min(max, Math.max(min, Number(next.toFixed(6))));
  useEffect(() => () => active.current?.cancel(), []);
  const previousTime = useRef(editTime);
  useEffect(() => {
    if (previousTime.current === editTime) return;
    previousTime.current = editTime;
    active.current?.cancel();
    setDraft(undefined);
  }, [editTime]);

  const commitDraft = () => {
    if (draft === undefined) return;
    const next = Number(draft);
    setDraft(undefined);
    if (draft.trim() && Number.isFinite(next) && next !== value && normalize(next) !== value)
      onValueChange(normalize(next), "commit");
  };

  return (
    <input
      {...props}
      className={`numeric-input ${className} ${dragging ? "scrubbing" : ""}`}
      data-editing={draft !== undefined || undefined}
      max={Number.isFinite(max) ? max : undefined}
      min={Number.isFinite(min) ? min : undefined}
      step={step}
      title={props.title ?? t("inspector.numeric.hint")}
      type={type}
      value={
        draft ?? Number(value.toFixed(Math.min(6, Math.max(3, 1 - Math.floor(Math.log10(step))))))
      }
      onBlur={() => commitDraft()}
      onChange={(event) => {
        if (type === "range") {
          const next = normalize(Number(event.target.value));
          if (active.current) active.current.move(next);
          else if (next !== value) onValueChange(next, "commit");
        } else setDraft(event.target.value);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          active.current?.cancel();
          setDraft(undefined);
        } else if (event.key === "Enter") {
          event.preventDefault();
          if (event.currentTarget === event.currentTarget.ownerDocument.activeElement)
            event.currentTarget.blur();
          else commitDraft();
        } else if (type === "number" && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          event.preventDefault();
          const base = draft?.trim() && Number.isFinite(Number(draft)) ? Number(draft) : value;
          const next = normalize(
            base +
              (event.key === "ArrowUp" ? 1 : -1) *
                step *
                (event.altKey ? 0.1 : event.shiftKey ? 10 : 1),
          );
          setDraft(undefined);
          if (next !== value) onValueChange(next, "commit");
        }
      }}
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          event.currentTarget.matches(":disabled") ||
          props.readOnly ||
          (type === "number" && draft !== undefined)
        )
          return;
        const target = event.currentTarget;
        const owner = target.ownerDocument.defaultView;
        if (!owner) return;
        if (type === "number") event.preventDefault();
        target.focus();
        let next = value;
        let raw = value;
        let lastX = event.clientX;
        const startX = event.clientX;
        let moved = false;
        let previewed = false;
        const coalescer = new RafCoalescer<number>(
          {
            request: (callback) => owner.requestAnimationFrame(callback),
            cancel: (handle) => owner.cancelAnimationFrame(handle),
          },
          (updated) => {
            previewed = true;
            onValueChange(updated, "preview");
          },
        );
        const move = (updated: number) => {
          next = updated;
          coalescer.schedule(updated);
        };
        const cancelOnEscape = (key: KeyboardEvent) => {
          if (key.key !== "Escape") return;
          key.preventDefault();
          key.stopPropagation();
          active.current?.cancel();
        };
        const finish = (cancelled: boolean) => {
          coalescer.cancel();
          owner.removeEventListener("keydown", cancelOnEscape, true);
          active.current = undefined;
          setDragging(false);
          if (cancelled || next === value) {
            if (previewed) onValueChange(value, "cancel");
          } else onValueChange(next, "commit");
          if (!cancelled && !moved && type === "number") {
            setDraft(String(value));
            target.select();
          }
        };
        const cancel = bindWindowPointerDrag(owner, event.pointerId, {
          onMove: (pointer) => {
            if (type === "range") return;
            if (!moved && Math.abs(pointer.clientX - startX) < 3) return;
            moved = true;
            setDragging(true);
            raw = Math.min(
              max,
              Math.max(
                min,
                raw +
                  (pointer.clientX - lastX) *
                    step *
                    (pointer.altKey ? 0.1 : pointer.shiftKey ? 10 : 1),
              ),
            );
            lastX = pointer.clientX;
            move(normalize(raw));
          },
          onCommit: () => finish(false),
          onCancel: () => finish(true),
        });
        active.current = { move, cancel };
        owner.addEventListener("keydown", cancelOnEscape, true);
      }}
    />
  );
}
