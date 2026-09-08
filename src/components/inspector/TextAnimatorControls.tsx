import { ChevronDown, ChevronUp, Copy, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  createDefaultExpressionSelector,
  createDefaultRangeSelector,
  createDefaultTextAnimatorGroup,
  createDefaultWigglySelector,
  duplicateTextAnimatorGroup,
  duplicateTextSelector,
  MAX_TEXT_SELECTORS_PER_GROUP,
} from "../../core/animation/text-animator-groups";
import {
  MAX_TEXT_ANIMATOR_GROUPS,
  type TextAnimatorGroup,
  type TextAnimatorStackSettings,
} from "../../core/animation/text-animator-stack";
import type { TextSelector } from "../../core/animation/text-selectors";
import { useI18n } from "../../i18n/react";
import { TextAnimatorPropertyControls } from "./TextAnimatorPropertyControls";
import { TextSelectorControls } from "./TextSelectorControls";

type SelectorKind = TextSelector["kind"];

export function TextAnimatorControls({
  onChange,
  settings,
  time,
}: {
  onChange: (settings: TextAnimatorStackSettings) => void;
  settings: TextAnimatorStackSettings;
  time: number;
}) {
  const { t } = useI18n();
  const updateGroup = (index: number, group: TextAnimatorGroup) => {
    const groups = [...settings.groups];
    groups[index] = group;
    onChange({ ...settings, groups });
  };
  const moveGroup = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= settings.groups.length) return;
    const groups = [...settings.groups];
    [groups[index], groups[target]] = [
      groups[target] as TextAnimatorGroup,
      groups[index] as TextAnimatorGroup,
    ];
    onChange({ ...settings, groups });
  };
  return (
    <div className="text-animator-controls">
      <div className="text-animator-toolbar">
        <label className="text-stack-toggle">
          <input
            checked={settings.enabled}
            onChange={(event) => onChange({ ...settings, enabled: event.target.checked })}
            type="checkbox"
          />
          <span>{t("text.animator.enabled")}</span>
        </label>
        <button
          aria-label={t("text.animator.add")}
          disabled={settings.groups.length >= MAX_TEXT_ANIMATOR_GROUPS}
          onClick={() =>
            onChange({
              ...settings,
              groups: [...settings.groups, createDefaultTextAnimatorGroup(settings.groups.length)],
            })
          }
          type="button"
        >
          <Plus aria-hidden="true" size={11} /> {t("text.animator.add")}
        </button>
      </div>
      {settings.enabled
        ? settings.groups.map((group, index) => (
            <AnimatorGroupControls
              canMoveDown={index < settings.groups.length - 1}
              canMoveUp={index > 0}
              canDuplicate={settings.groups.length < MAX_TEXT_ANIMATOR_GROUPS}
              group={group}
              key={group.id}
              onChange={(next) => updateGroup(index, next)}
              onMoveDown={() => moveGroup(index, 1)}
              onMoveUp={() => moveGroup(index, -1)}
              onDuplicate={() => {
                const groups = [...settings.groups];
                groups.splice(index + 1, 0, duplicateTextAnimatorGroup(group));
                onChange({ ...settings, groups });
              }}
              onRemove={() =>
                onChange({
                  ...settings,
                  groups: settings.groups.filter((_, candidate) => candidate !== index),
                })
              }
              time={time}
            />
          ))
        : null}
    </div>
  );
}

function AnimatorGroupControls({
  canMoveDown,
  canMoveUp,
  canDuplicate,
  group,
  onChange,
  onMoveDown,
  onMoveUp,
  onDuplicate,
  onRemove,
  time,
}: {
  canMoveDown: boolean;
  canMoveUp: boolean;
  canDuplicate: boolean;
  group: TextAnimatorGroup;
  onChange: (group: TextAnimatorGroup) => void;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  time: number;
}) {
  const { t } = useI18n();
  const [selectorKind, setSelectorKind] = useState<SelectorKind>("range");
  const label = group.name ?? t("text.animator.enabled");
  const updateSelector = (index: number, selector: TextSelector) => {
    const selectors = [...group.selectors];
    selectors[index] = selector;
    onChange({ ...group, selectors });
  };
  const moveSelector = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= group.selectors.length) return;
    const selectors = [...group.selectors];
    [selectors[index], selectors[target]] = [
      selectors[target] as TextSelector,
      selectors[index] as TextSelector,
    ];
    onChange({ ...group, selectors });
  };
  const addSelector = () => {
    if (group.selectors.length >= MAX_TEXT_SELECTORS_PER_GROUP) return;
    const kindIndex = group.selectors.filter((selector) => selector.kind === selectorKind).length;
    const selector =
      selectorKind === "range"
        ? createDefaultRangeSelector(kindIndex)
        : selectorKind === "wiggly"
          ? createDefaultWigglySelector(kindIndex)
          : createDefaultExpressionSelector(kindIndex);
    onChange({ ...group, selectors: [...group.selectors, selector] });
  };
  return (
    <section className="text-animator-group">
      <header>
        <label className="text-stack-toggle">
          <input
            aria-label={t("text.selector.enabled", { label })}
            checked={group.enabled}
            onChange={(event) => onChange({ ...group, enabled: event.target.checked })}
            type="checkbox"
          />
          <input
            aria-label={t("text.animator.name")}
            maxLength={128}
            onChange={(event) => onChange({ ...group, name: event.target.value })}
            type="text"
            value={group.name ?? ""}
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
          aria-label={t("text.animator.duplicate", { label })}
          disabled={!canDuplicate}
          onClick={onDuplicate}
          type="button"
        >
          <Copy aria-hidden="true" size={10} />
        </button>
        <button aria-label={t("text.animator.remove")} onClick={onRemove} type="button">
          <Trash2 aria-hidden="true" size={10} />
        </button>
      </header>
      <label className="text-animator-seed">
        {t("text.animator.randomSeed")}
        <input
          onChange={(event) => onChange({ ...group, randomSeed: Number(event.target.value) })}
          type="number"
          value={group.randomSeed}
        />
      </label>
      <div className="text-animator-subheading">{t("text.animator.properties")}</div>
      <TextAnimatorPropertyControls
        onChange={(properties) => onChange({ ...group, properties })}
        properties={group.properties}
        time={time}
      />
      <div className="text-animator-subheading">{t("text.animator.selectors")}</div>
      <div className="text-stack-add-row">
        <select
          aria-label={t("text.animator.addSelector")}
          disabled={group.selectors.length >= MAX_TEXT_SELECTORS_PER_GROUP}
          onChange={(event) => setSelectorKind(event.target.value as SelectorKind)}
          value={selectorKind}
        >
          <option value="range">{t("text.selector.range")}</option>
          <option value="wiggly">{t("text.selector.wiggly")}</option>
          <option value="expression">{t("text.selector.expression")}</option>
        </select>
        <button
          disabled={group.selectors.length >= MAX_TEXT_SELECTORS_PER_GROUP}
          onClick={addSelector}
          type="button"
        >
          <Plus aria-hidden="true" size={11} /> {t("text.animator.addSelector")}
        </button>
      </div>
      {group.selectors.map((selector, index) => (
        <TextSelectorControls
          canMoveDown={index < group.selectors.length - 1}
          canMoveUp={index > 0}
          canDuplicate={group.selectors.length < MAX_TEXT_SELECTORS_PER_GROUP}
          key={selector.id}
          onChange={(next) => updateSelector(index, next)}
          onMoveDown={() => moveSelector(index, 1)}
          onMoveUp={() => moveSelector(index, -1)}
          onDuplicate={() => {
            const selectors = [...group.selectors];
            selectors.splice(index + 1, 0, duplicateTextSelector(selector));
            onChange({ ...group, selectors });
          }}
          onRemove={() =>
            onChange({
              ...group,
              selectors: group.selectors.filter((_, candidate) => candidate !== index),
            })
          }
          selector={selector}
          time={time}
        />
      ))}
    </section>
  );
}
