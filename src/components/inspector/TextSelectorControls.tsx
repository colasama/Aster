import { ChevronDown, ChevronUp, Copy, Trash2 } from "lucide-react";
import { textSelectorExpressionError } from "../../core/animation/text-selector-expression";
import type {
  TextRangeSelector,
  TextSelector,
  TextSelectorBasedOn,
  TextSelectorMode,
  TextWigglySelector,
} from "../../core/animation/text-selectors";
import type { Animatable } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { valuesDiffer } from "./inspector-selection";
import { MixedValueInput, MixedValueSelect, MixedValueTextarea } from "./MixedValueInput";
import { type SettingsEdit, settingsEdit } from "./settings-edit";
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
  selection = [selector],
  time,
  times,
}: {
  canMoveDown: boolean;
  canMoveUp: boolean;
  canDuplicate: boolean;
  onChange: SettingsEdit<TextSelector>;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  selector: TextSelector;
  selection?: readonly TextSelector[];
  time: number;
  times?: readonly number[];
}) {
  const { t } = useI18n();
  const edit = settingsEdit(selector, onChange, selection.length);
  const update = (patch: Partial<TextSelector>) =>
    edit((current) => ({ ...current, ...patch }) as TextSelector);
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
      onChange={(value, recipe) =>
        edit(
          (current, index) =>
            ({
              ...current,
              [field]: recipe ? recipe(Reflect.get(current, field) as Animatable, index) : value,
            }) as TextSelector,
        )
      }
      selection={selection.map((entry) => Reflect.get(entry, field) as Animatable)}
      times={times}
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
          <MixedValueInput
            aria-label={t("text.selector.enabled", { label })}
            mixed={valuesDiffer(selection.map((entry) => Reflect.get(entry, "enabled")))}
            checked={selector.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
            type="checkbox"
          />
          <MixedValueInput
            aria-label={t("text.selector.name")}
            maxLength={128}
            onChange={(event) => update({ name: event.target.value })}
            placeholder={kindLabel}
            type="text"
            mixed={valuesDiffer(selection.map((entry) => Reflect.get(entry, "name")))}
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
          <MixedValueSelect
            onChange={(event) => update({ mode: event.target.value as TextSelectorMode })}
            mixed={valuesDiffer(selection.map((entry) => Reflect.get(entry, "mode")))}
            value={selector.mode}
          >
            {(["add", "subtract", "intersect", "min", "max", "difference"] as const).map((mode) => (
              <option key={mode} value={mode}>
                {t(`text.selector.mode.${mode}`)}
              </option>
            ))}
          </MixedValueSelect>
        </label>
        <label>
          {t("text.selector.basedOn")}
          <MixedValueSelect
            onChange={(event) => update({ basedOn: event.target.value as TextSelectorBasedOn })}
            mixed={valuesDiffer(selection.map((entry) => Reflect.get(entry, "basedOn")))}
            value={selector.basedOn}
          >
            {(["characters", "charactersExcludingSpaces", "words", "lines"] as const).map(
              (basedOn) => (
                <option key={basedOn} value={basedOn}>
                  {t(`text.selector.basedOn.${basedOn}`)}
                </option>
              ),
            )}
          </MixedValueSelect>
        </label>
        {animated(t("text.selector.amount"), selector.amount, "amount", -100, 100, 1)}
      </div>
      {selector.kind === "range" ? (
        <RangeSelectorFields
          animated={animated}
          onChange={(value, recipe) =>
            edit((current, index) => (recipe ? recipe(current as typeof selector, index) : value))
          }
          selection={selection.filter(
            (entry): entry is typeof selector => entry.kind === selector.kind,
          )}
          selector={selector}
        />
      ) : selector.kind === "wiggly" ? (
        <WigglySelectorFields
          animated={animated}
          onChange={(value, recipe) =>
            edit((current, index) => (recipe ? recipe(current as typeof selector, index) : value))
          }
          selection={selection.filter(
            (entry): entry is typeof selector => entry.kind === selector.kind,
          )}
          selector={selector}
        />
      ) : (
        <label className="text-expression-field">
          {t("text.selector.expressionSource")}
          <MixedValueTextarea
            aria-invalid={Boolean(expressionError)}
            maxLength={2_048}
            onChange={(event) => update({ expression: event.target.value })}
            rows={3}
            spellCheck={false}
            mixed={valuesDiffer(selection.map((entry) => Reflect.get(entry, "expression")))}
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
  selection = [selector],
}: {
  animated: AnimatedField;
  onChange: SettingsEdit<TextRangeSelector>;
  selector: TextRangeSelector;
  selection?: readonly TextRangeSelector[];
}) {
  const { t } = useI18n();
  const edit = settingsEdit(selector, onChange, selection.length);
  const update = (patch: Partial<TextRangeSelector>) =>
    edit((current) => ({ ...current, ...patch }));
  return (
    <div className="text-selector-grid range-fields">
      <label>
        {t("text.selector.units")}
        <MixedValueSelect
          onChange={(event) => update({ units: event.target.value as TextRangeSelector["units"] })}
          mixed={valuesDiffer(selection.map((entry) => Reflect.get(entry, "units")))}
          value={selector.units}
        >
          <option value="percentage">{t("text.selector.units.percentage")}</option>
          <option value="index">{t("text.selector.units.index")}</option>
        </MixedValueSelect>
      </label>
      <label>
        {t("text.selector.shape")}
        <MixedValueSelect
          onChange={(event) => update({ shape: event.target.value as TextRangeSelector["shape"] })}
          mixed={valuesDiffer(selection.map((entry) => Reflect.get(entry, "shape")))}
          value={selector.shape}
        >
          {(["square", "rampUp", "rampDown", "triangle", "round", "smooth"] as const).map(
            (shape) => (
              <option key={shape} value={shape}>
                {t(`text.selector.shape.${shape}`)}
              </option>
            ),
          )}
        </MixedValueSelect>
      </label>
      {animated(t("text.selector.start"), selector.start, "start", -1_000_000, 1_000_000)}
      {animated(t("text.selector.end"), selector.end, "end", -1_000_000, 1_000_000)}
      {animated(t("text.selector.offset"), selector.offset, "offset", -1_000_000, 1_000_000)}
      {animated(t("text.selector.smoothness"), selector.smoothness, "smoothness", 0, 100)}
      {animated(t("text.selector.easeHigh"), selector.easeHigh, "easeHigh", -100, 100)}
      {animated(t("text.selector.easeLow"), selector.easeLow, "easeLow", -100, 100)}
      <label className="text-selector-check">
        <MixedValueInput
          mixed={valuesDiffer(selection.map((entry) => Reflect.get(entry, "randomizeOrder")))}
          checked={selector.randomizeOrder}
          onChange={(event) => update({ randomizeOrder: event.target.checked })}
          type="checkbox"
        />
        {t("text.selector.randomizeOrder")}
      </label>
      <label>
        {t("text.selector.randomSeed")}
        <MixedValueInput
          onChange={(event) => update({ randomSeed: Number(event.target.value) })}
          type="number"
          mixed={valuesDiffer(selection.map((entry) => Reflect.get(entry, "randomSeed")))}
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
  selection = [selector],
}: {
  animated: AnimatedField;
  onChange: SettingsEdit<TextWigglySelector>;
  selector: TextWigglySelector;
  selection?: readonly TextWigglySelector[];
}) {
  const { t } = useI18n();
  const edit = settingsEdit(selector, onChange, selection.length);
  const update = (patch: Partial<TextWigglySelector>) =>
    edit((current) => ({ ...current, ...patch }));
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
        <MixedValueInput
          onChange={(event) => update({ randomSeed: Number(event.target.value) })}
          type="number"
          mixed={valuesDiffer(selection.map((entry) => Reflect.get(entry, "randomSeed")))}
          value={selector.randomSeed}
        />
      </label>
    </div>
  );
}
