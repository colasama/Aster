import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { useI18n } from "../../i18n/react";

export function MixedValueInput({
  mixed = false,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { mixed?: boolean }) {
  const { t } = useI18n();
  const input = (
    <input
      {...props}
      data-mixed={mixed || undefined}
      aria-description={mixed ? t("inspector.mixed") : props["aria-description"]}
      ref={(element) => {
        if (element) element.indeterminate = mixed;
      }}
      placeholder={mixed ? "—" : props.placeholder}
      value={mixed && props.type !== "color" && props.type !== "range" ? "" : props.value}
      onChange={(event) => {
        if (props.type === "number" && !Number.isFinite(event.target.valueAsNumber)) return;
        props.onChange?.(event);
      }}
    />
  );
  return props.type === "color" ? (
    <span className="mixed-color-input">
      {mixed && <span aria-hidden="true">—</span>}
      {input}
    </span>
  ) : (
    input
  );
}

export function MixedValueSelect({
  mixed = false,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { mixed?: boolean }) {
  return (
    <select {...props} data-mixed={mixed || undefined} value={mixed ? "__mixed__" : props.value}>
      {mixed && (
        <option disabled value="__mixed__">
          —
        </option>
      )}
      {children}
    </select>
  );
}

export function MixedValueTextarea({
  mixed = false,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { mixed?: boolean }) {
  return (
    <textarea
      {...props}
      data-mixed={mixed || undefined}
      placeholder={mixed ? "—" : props.placeholder}
      value={mixed ? "" : props.value}
    />
  );
}
