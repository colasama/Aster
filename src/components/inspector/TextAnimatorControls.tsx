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
import { valuesDiffer } from "./inspector-selection";
import { MixedValueInput } from "./MixedValueInput";
import { type SettingsEdit, type SettingsRecipe, settingsEdit } from "./settings-edit";
import { TextAnimatorPropertyControls } from "./TextAnimatorPropertyControls";
import { TextSelectorControls } from "./TextSelectorControls";

type SelectorKind = TextSelector["kind"];

export function TextAnimatorControls({
  onChange,
  settings,
  selection = [settings],
  times,
  time,
}: {
  onChange: SettingsEdit<TextAnimatorStackSettings>;
  selection?: readonly TextAnimatorStackSettings[];
  times?: readonly number[];
  settings: TextAnimatorStackSettings;
  time: number;
}) {
  const { t } = useI18n();
  const edit = settingsEdit(settings, onChange, selection.length);
  const updateGroup = (
    index: number,
    group: TextAnimatorGroup,
    recipe?: SettingsRecipe<TextAnimatorGroup>,
  ) =>
    edit((current, targetIndex) => ({
      ...current,
      groups: current.groups.map((entry, groupIndex) =>
        groupIndex === index ? (recipe ? recipe(entry, targetIndex) : group) : entry,
      ),
    }));
  const moveGroup = (index: number, direction: -1 | 1) =>
    edit((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.groups.length) return current;
      const groups = [...current.groups];
      [groups[index], groups[target]] = [
        groups[target] as TextAnimatorGroup,
        groups[index] as TextAnimatorGroup,
      ];
      return { ...current, groups };
    });
  return (
    <div className="text-animator-controls">
      <div className="text-animator-toolbar">
        <label className="text-stack-toggle">
          <MixedValueInput
            mixed={valuesDiffer(selection.map((entry) => entry.enabled))}
            checked={settings.enabled}
            onChange={(event) => edit((current) => ({ ...current, enabled: event.target.checked }))}
            type="checkbox"
          />
          <span>{t("text.animator.enabled")}</span>
        </label>
        <button
          aria-label={t("text.animator.add")}
          disabled={selection.some((entry) => entry.groups.length >= MAX_TEXT_ANIMATOR_GROUPS)}
          onClick={() =>
            edit((current) => ({
              ...current,
              groups: [...current.groups, createDefaultTextAnimatorGroup(current.groups.length)],
            }))
          }
          type="button"
        >
          <Plus aria-hidden="true" size={11} /> {t("text.animator.add")}
        </button>
      </div>
      {selection.every((entry) => entry.enabled)
        ? settings.groups.map(
            (group, index) =>
              selection.every((entry) => entry.groups[index]) && (
                <AnimatorGroupControls
                  canMoveDown={selection.every((entry) => index < entry.groups.length - 1)}
                  canMoveUp={index > 0}
                  canDuplicate={selection.every(
                    (entry) => entry.groups.length < MAX_TEXT_ANIMATOR_GROUPS,
                  )}
                  group={group}
                  selection={selection.map((entry) => entry.groups[index] as TextAnimatorGroup)}
                  times={times}
                  key={group.id}
                  onChange={(next, recipe) => updateGroup(index, next, recipe)}
                  onMoveDown={() => moveGroup(index, 1)}
                  onMoveUp={() => moveGroup(index, -1)}
                  onDuplicate={() =>
                    edit((current) => {
                      const groups = [...current.groups];
                      groups.splice(
                        index + 1,
                        0,
                        duplicateTextAnimatorGroup(groups[index] as TextAnimatorGroup),
                      );
                      return { ...current, groups };
                    })
                  }
                  onRemove={() =>
                    edit((current) => ({
                      ...current,
                      groups: current.groups.filter((_, candidate) => candidate !== index),
                    }))
                  }
                  time={time}
                />
              ),
          )
        : null}
    </div>
  );
}

function AnimatorGroupControls({
  canMoveDown,
  canMoveUp,
  canDuplicate,
  group,
  selection = [group],
  times,
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
  selection?: readonly TextAnimatorGroup[];
  times?: readonly number[];
  onChange: SettingsEdit<TextAnimatorGroup>;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  time: number;
}) {
  const { t } = useI18n();
  const [selectorKind, setSelectorKind] = useState<SelectorKind>("range");
  const label = group.name ?? t("text.animator.enabled");
  const edit = settingsEdit(group, onChange, selection.length);
  const updateSelector = (
    index: number,
    selector: TextSelector,
    recipe?: SettingsRecipe<TextSelector>,
  ) =>
    edit((current, targetIndex) => ({
      ...current,
      selectors: current.selectors.map((entry, selectorIndex) =>
        selectorIndex === index ? (recipe ? recipe(entry, targetIndex) : selector) : entry,
      ),
    }));
  const moveSelector = (index: number, direction: -1 | 1) =>
    edit((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.selectors.length) return current;
      const selectors = [...current.selectors];
      [selectors[index], selectors[target]] = [
        selectors[target] as TextSelector,
        selectors[index] as TextSelector,
      ];
      return { ...current, selectors };
    });
  const addSelector = () =>
    edit((current) => {
      if (current.selectors.length >= MAX_TEXT_SELECTORS_PER_GROUP) return current;
      const kindIndex = current.selectors.filter(
        (selector) => selector.kind === selectorKind,
      ).length;
      const selector =
        selectorKind === "range"
          ? createDefaultRangeSelector(kindIndex)
          : selectorKind === "wiggly"
            ? createDefaultWigglySelector(kindIndex)
            : createDefaultExpressionSelector(kindIndex);
      return { ...current, selectors: [...current.selectors, selector] };
    });
  return (
    <section className="text-animator-group">
      <header>
        <label className="text-stack-toggle">
          <MixedValueInput
            aria-label={t("text.selector.enabled", { label })}
            mixed={valuesDiffer(selection.map((entry) => entry.enabled))}
            checked={group.enabled}
            onChange={(event) => edit((current) => ({ ...current, enabled: event.target.checked }))}
            type="checkbox"
          />
          <MixedValueInput
            aria-label={t("text.animator.name")}
            maxLength={128}
            onChange={(event) => edit((current) => ({ ...current, name: event.target.value }))}
            type="text"
            mixed={valuesDiffer(selection.map((entry) => entry.name ?? ""))}
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
        <MixedValueInput
          onChange={(event) =>
            edit((current) => ({ ...current, randomSeed: Number(event.target.value) }))
          }
          type="number"
          mixed={valuesDiffer(selection.map((entry) => entry.randomSeed))}
          value={group.randomSeed}
        />
      </label>
      <div className="text-animator-subheading">{t("text.animator.properties")}</div>
      <TextAnimatorPropertyControls
        onChange={(properties, recipe) =>
          edit((current, index) => ({
            ...current,
            properties: recipe ? recipe(current.properties, index) : properties,
          }))
        }
        selection={selection.map((entry) => entry.properties)}
        times={times}
        properties={group.properties}
        time={time}
      />
      <div className="text-animator-subheading">{t("text.animator.selectors")}</div>
      <div className="text-stack-add-row">
        <select
          aria-label={t("text.animator.addSelector")}
          disabled={selection.some(
            (entry) => entry.selectors.length >= MAX_TEXT_SELECTORS_PER_GROUP,
          )}
          onChange={(event) => setSelectorKind(event.target.value as SelectorKind)}
          value={selectorKind}
        >
          <option value="range">{t("text.selector.range")}</option>
          <option value="wiggly">{t("text.selector.wiggly")}</option>
          <option value="expression">{t("text.selector.expression")}</option>
        </select>
        <button
          disabled={selection.some(
            (entry) => entry.selectors.length >= MAX_TEXT_SELECTORS_PER_GROUP,
          )}
          onClick={addSelector}
          type="button"
        >
          <Plus aria-hidden="true" size={11} /> {t("text.animator.addSelector")}
        </button>
      </div>
      {group.selectors.map(
        (selector, index) =>
          selection.every((entry) => entry.selectors[index]?.kind === selector.kind) && (
            <TextSelectorControls
              canMoveDown={selection.every((entry) => index < entry.selectors.length - 1)}
              canMoveUp={index > 0}
              canDuplicate={selection.every(
                (entry) => entry.selectors.length < MAX_TEXT_SELECTORS_PER_GROUP,
              )}
              key={selector.id}
              onChange={(next, recipe) => updateSelector(index, next, recipe)}
              selection={selection.map((entry) => entry.selectors[index] as TextSelector)}
              times={times}
              onMoveDown={() => moveSelector(index, 1)}
              onMoveUp={() => moveSelector(index, -1)}
              onDuplicate={() =>
                edit((current) => {
                  const selectors = [...current.selectors];
                  selectors.splice(
                    index + 1,
                    0,
                    duplicateTextSelector(selectors[index] as TextSelector),
                  );
                  return { ...current, selectors };
                })
              }
              onRemove={() =>
                edit((current) => ({
                  ...current,
                  selectors: current.selectors.filter((_, candidate) => candidate !== index),
                }))
              }
              selector={selector}
              time={time}
            />
          ),
      )}
    </section>
  );
}
