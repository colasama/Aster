import { ChevronDown, ChevronUp, Copy, Trash2 } from "lucide-react";
import { textSelectorExpressionError } from "../core/text-selector-expression";
import type {
  TextRangeSelector,
  TextSelector,
  TextSelectorBasedOn,
  TextSelectorMode,
  TextWigglySelector,
} from "../core/text-selectors";
import type { Animatable } from "../core/types";
import { useI18n } from "../i18n/react";
import { TextAnimatableControl } from "./TextAnimatableControl";

export function TextSelectorControls({
  canMoveDown,
  canMoveUp,
  canDuplicate,
  onChange,
  onMoveDown,
  onMoveUp,
  onDuplicate,
  onRemove,
  selector,
  time,
}: {
  canMoveDown: boolean;
  canMoveUp: boolean;
  canDuplicate: boolean;
  onChange: (selector: TextSelector) => void;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  selector: TextSelector;
  time: number;
}) {
  const { t } = useI18n();
  const update = (patch: Partial<TextSelector>) =>
    onChange({ ...selector, ...patch } as TextSelector);
  const animated = (
    label: string,
    property: Animatable,
    field: string,
    min?: number,
    max?: number,
    step?: number,
  ) => (
    <TextAnimatableControl
      key={field}
      keyframeLabel={t("text.keyframe", { label })}
      label={label}
      max={max}
      min={min}
      onChange={(value) => update({ [field]: value } as Partial<TextSelector>)}
      property={property}
      step={step}
      time={time}
    />
  );
  const kindLabel = t(
    selector.kind === "range"
      ? "text.selector.range"
      : selector.kind === "wiggly"
        ? "text.selector.wiggly"
        : "text.selector.expression",
  );
  const label = selector.name || kindLabel;
  const expressionError =
    selector.kind === "expression" ? textSelectorExpressionError(selector.expression) : undefined;
  return (
    <section className="text-selector-control">
      <header>
        <label className="text-stack-toggle">
          <input
            aria-label={t("text.selector.enabled", { label })}
            checked={selector.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
            type="checkbox"
          />
          <input
            aria-label={t("text.selector.name")}
            maxLength={128}
            onChange={(event) => update({ name: event.target.value })}
            placeholder={kindLabel}
            type="text"
            value={selector.name}
          />
        </label>
        <button
          aria-label={t("text.moveUp", { label })}
          disabled={!canMoveUp}
          onClick={onMoveUp}
          type="button"
        >
          <ChevronUp aria-hidden="true" size={11} />
        </button>
        <button
          aria-label={t("text.moveDown", { label })}
          disabled={!canMoveDown}
          onClick={onMoveDown}
          type="button"
        >
          <ChevronDown aria-hidden="true" size={11} />
        </button>
        <button
          aria-label={t("text.selector.duplicate", { label })}
          disabled={!canDuplicate}
          onClick={onDuplicate}
          type="button"
        >
          <Copy aria-hidden="true" size={10} />
        </button>
        <button aria-label={t("text.selector.remove")} onClick={onRemove} type="button">
          <Trash2 aria-hidden="true" size={10} />
        </button>
      </header>
      <div className="text-selector-grid">
        <label>
          {t("text.selector.mode")}
          <select
            onChange={(event) => update({ mode: event.target.value as TextSelectorMode })}
            value={selector.mode}
          >
            {(["add", "subtract", "intersect", "min", "max", "difference"] as const).map((mode) => (
              <option key={mode} value={mode}>
                {t(`text.selector.mode.${mode}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("text.selector.basedOn")}
          <select
            onChange={(event) => update({ basedOn: event.target.value as TextSelectorBasedOn })}
            value={selector.basedOn}
          >
            {(["characters", "charactersExcludingSpaces", "words", "lines"] as const).map(
              (basedOn) => (
                <option key={basedOn} value={basedOn}>
                  {t(`text.selector.basedOn.${basedOn}`)}
                </option>
              ),
            )}
          </select>
        </label>
        {animated(t("text.selector.amount"), selector.amount, "amount", -100, 100, 1)}
      </div>
      {selector.kind === "range" ? (
        <RangeSelectorFields animated={animated} onChange={onChange} selector={selector} />
      ) : selector.kind === "wiggly" ? (
        <WigglySelectorFields animated={animated} onChange={onChange} selector={selector} />
      ) : (
        <label className="text-expression-field">
          {t("text.selector.expressionSource")}
          <textarea
            aria-invalid={Boolean(expressionError)}
            maxLength={2_048}
            onChange={(event) => update({ expression: event.target.value })}
            rows={3}
            spellCheck={false}
            value={selector.expression}
          />
          {expressionError ? <span role="alert">{expressionError}</span> : null}
        </label>
      )}
    </section>
  );
}

type AnimatedField = (
  label: string,
  property: Animatable,
  field: string,
  min?: number,
  max?: number,
  step?: number,
) => React.ReactNode;

function RangeSelectorFields({
  animated,
  onChange,
  selector,
}: {
  animated: AnimatedField;
  onChange: (selector: TextSelector) => void;
  selector: TextRangeSelector;
}) {
  const { t } = useI18n();
  const update = (patch: Partial<TextRangeSelector>) => onChange({ ...selector, ...patch });
  return (
    <div className="text-selector-grid range-fields">
      <label>
        {t("text.selector.units")}
        <select
          onChange={(event) => update({ units: event.target.value as TextRangeSelector["units"] })}
          value={selector.units}
        >
          <option value="percentage">{t("text.selector.units.percentage")}</option>
          <option value="index">{t("text.selector.units.index")}</option>
        </select>
      </label>
      <label>
        {t("text.selector.shape")}
        <select
          onChange={(event) => update({ shape: event.target.value as TextRangeSelector["shape"] })}
          value={selector.shape}
        >
          {(["square", "rampUp", "rampDown", "triangle", "round", "smooth"] as const).map(
            (shape) => (
              <option key={shape} value={shape}>
                {t(`text.selector.shape.${shape}`)}
              </option>
            ),
          )}
        </select>
      </label>
      {animated(t("text.selector.start"), selector.start, "start", -1_000_000, 1_000_000)}
      {animated(t("text.selector.end"), selector.end, "end", -1_000_000, 1_000_000)}
      {animated(t("text.selector.offset"), selector.offset, "offset", -1_000_000, 1_000_000)}
      {animated(t("text.selector.smoothness"), selector.smoothness, "smoothness", 0, 100)}
      {animated(t("text.selector.easeHigh"), selector.easeHigh, "easeHigh", -100, 100)}
      {animated(t("text.selector.easeLow"), selector.easeLow, "easeLow", -100, 100)}
      <label className="text-selector-check">
        <input
          checked={selector.randomizeOrder}
          onChange={(event) => update({ randomizeOrder: event.target.checked })}
          type="checkbox"
        />
        {t("text.selector.randomizeOrder")}
      </label>
      <label>
        {t("text.selector.randomSeed")}
        <input
          onChange={(event) => update({ randomSeed: Number(event.target.value) })}
          type="number"
          value={selector.randomSeed}
        />
      </label>
    </div>
  );
}

function WigglySelectorFields({
  animated,
  onChange,
  selector,
}: {
  animated: AnimatedField;
  onChange: (selector: TextSelector) => void;
  selector: TextWigglySelector;
}) {
  const { t } = useI18n();
  const update = (patch: Partial<TextWigglySelector>) => onChange({ ...selector, ...patch });
  return (
    <div className="text-selector-grid wiggly-fields">
      {animated(
        t("text.selector.minimumAmount"),
        selector.minimumAmount,
        "minimumAmount",
        -100,
        100,
      )}
      {animated(
        t("text.selector.maximumAmount"),
        selector.maximumAmount,
        "maximumAmount",
        -100,
        100,
      )}
      {animated(
        t("text.selector.wigglesPerSecond"),
        selector.wigglesPerSecond,
        "wigglesPerSecond",
        0,
        100,
        0.1,
      )}
      {animated(t("text.selector.correlation"), selector.correlation, "correlation", 0, 100)}
      {animated(
        t("text.selector.temporalPhase"),
        selector.temporalPhase,
        "temporalPhase",
        -1_000_000,
        1_000_000,
        0.1,
      )}
      {animated(
        t("text.selector.spatialPhase"),
        selector.spatialPhase,
        "spatialPhase",
        -1_000_000,
        1_000_000,
        0.1,
      )}
      <label>
        {t("text.selector.randomSeed")}
        <input
          onChange={(event) => update({ randomSeed: Number(event.target.value) })}
          type="number"
          value={selector.randomSeed}
        />
      </label>
    </div>
  );
}
