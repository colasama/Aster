import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type {
  TextAnimatorColorProperty,
  TextAnimatorProperties,
  TextAnimatorVector2Property,
  TextAnimatorVector3Property,
} from "../../core/animation/text-animator-stack";
import { type Animatable, staticValue } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { TextAnimatableControl } from "./TextAnimatableControl";

type TextAnimatorPropertyName = Exclude<keyof TextAnimatorProperties, "characterRange">;

const PROPERTY_NAMES: readonly TextAnimatorPropertyName[] = [
  "anchorPoint",
  "position",
  "scale",
  "rotation",
  "skew",
  "skewAxis",
  "opacity",
  "fillColor",
  "strokeColor",
  "strokeWidth",
  "tracking",
  "lineAnchor",
  "lineSpacing",
  "characterOffset",
  "characterValue",
  "blur",
];

export function TextAnimatorPropertyControls({
  onChange,
  properties,
  time,
}: {
  onChange: (properties: TextAnimatorProperties) => void;
  properties: TextAnimatorProperties;
  time: number;
}) {
  const { t } = useI18n();
  const [nextProperty, setNextProperty] = useState<TextAnimatorPropertyName>("position");
  const available = PROPERTY_NAMES.filter((name) => properties[name] === undefined);
  const selected = available.includes(nextProperty) ? nextProperty : available[0];
  const add = () => {
    if (!selected) return;
    onChange({
      ...properties,
      [selected]: defaultProperty(selected),
      ...(selected === "characterOffset" || selected === "characterValue"
        ? { characterRange: properties.characterRange ?? "preserveCaseAndDigits" }
        : {}),
    });
  };
  return (
    <div className="text-animator-properties">
      <div className="text-stack-add-row">
        <select
          aria-label={t("text.animator.addProperty")}
          disabled={!selected}
          onChange={(event) => setNextProperty(event.target.value as TextAnimatorPropertyName)}
          value={selected ?? ""}
        >
          {available.map((name) => (
            <option key={name} value={name}>
              {t(`text.property.${name}`)}
            </option>
          ))}
        </select>
        <button disabled={!selected} onClick={add} type="button">
          <Plus aria-hidden="true" size={11} /> {t("text.animator.addProperty")}
        </button>
      </div>
      {properties.characterOffset !== undefined || properties.characterValue !== undefined ? (
        <label className="text-property-enum">
          <span>{t("text.property.characterRange")}</span>
          <select
            aria-label={t("text.property.characterRange")}
            onChange={(event) =>
              onChange({
                ...properties,
                characterRange: event.target.value as NonNullable<
                  TextAnimatorProperties["characterRange"]
                >,
              })
            }
            value={properties.characterRange ?? "preserveCaseAndDigits"}
          >
            <option value="preserveCaseAndDigits">
              {t("text.characterRange.preserveCaseAndDigits")}
            </option>
            <option value="fullUnicode">{t("text.characterRange.fullUnicode")}</option>
          </select>
        </label>
      ) : null}
      {PROPERTY_NAMES.flatMap((name) => {
        const property = properties[name];
        if (property === undefined) return [];
        const label = t(`text.property.${name}`);
        return [
          <section className="text-animator-property" key={name}>
            <header>
              <strong>{label}</strong>
              <button
                aria-label={t("text.animator.removeProperty", { label })}
                onClick={() => {
                  const next = { ...properties };
                  delete next[name];
                  if (
                    (name === "characterOffset" && next.characterValue === undefined) ||
                    (name === "characterValue" && next.characterOffset === undefined)
                  )
                    delete next.characterRange;
                  onChange(next);
                }}
                type="button"
              >
                <Trash2 aria-hidden="true" size={10} />
              </button>
            </header>
            <PropertyFields
              name={name}
              onChange={(value) => onChange({ ...properties, [name]: value })}
              property={property}
              time={time}
            />
          </section>,
        ];
      })}
    </div>
  );
}

function PropertyFields({
  name,
  onChange,
  property,
  time,
}: {
  name: TextAnimatorPropertyName;
  onChange: (value: TextAnimatorProperties[TextAnimatorPropertyName]) => void;
  property: NonNullable<TextAnimatorProperties[TextAnimatorPropertyName]>;
  time: number;
}) {
  const { t } = useI18n();
  const label = t(`text.property.${name}`);
  const animated = (value: Animatable, index?: number) => (
    <TextAnimatableControl
      key={index ?? 0}
      keyframeLabel={t("text.keyframe", { label })}
      label={index === undefined ? label : `${label} ${axisLabel(name, index)}`}
      min={propertyBounds(name)[0]}
      max={propertyBounds(name)[1]}
      onChange={(next) => {
        if (index === undefined) onChange(next);
        else {
          const vector = [...(property as Animatable[])] as Animatable[];
          vector[index] = next;
          onChange(vector as NonNullable<TextAnimatorProperties[TextAnimatorPropertyName]>);
        }
      }}
      property={value}
      step={name.includes("Color") ? 0.01 : 1}
      time={time}
    />
  );
  return Array.isArray(property) ? (
    <div className={`text-property-vector vector-${property.length}`}>
      {property.map((value, index) => animated(value, index))}
    </div>
  ) : (
    animated(property)
  );
}

function defaultProperty(
  name: TextAnimatorPropertyName,
): NonNullable<TextAnimatorProperties[TextAnimatorPropertyName]> {
  if (name === "scale") return vector3(100, 100, 100);
  if (name === "opacity") return staticValue(100);
  if (name === "fillColor" || name === "strokeColor") return color(1, 1, 1, 1);
  if (name === "characterValue") return staticValue(65);
  if (name === "anchorPoint" || name === "position" || name === "rotation") return vector3(0, 0, 0);
  if (name === "lineAnchor") return staticValue(50);
  if (name === "lineSpacing" || name === "blur") return vector2(0, 0);
  return staticValue(0);
}

function propertyBounds(name: TextAnimatorPropertyName): [number | undefined, number | undefined] {
  if (name === "opacity") return [0, 100];
  if (name === "scale") return [-10_000, 10_000];
  if (name === "fillColor" || name === "strokeColor") return [0, 1];
  if (name === "blur") return [0, 4096];
  if (name === "characterValue") return [0, 0x10ffff];
  if (name === "characterOffset") return [-0x10ffff, 0x10ffff];
  if (name === "lineAnchor") return [0, 100];
  return [undefined, undefined];
}

function axisLabel(name: TextAnimatorPropertyName, index: number): string {
  if (name === "fillColor" || name === "strokeColor") return ["R", "G", "B", "A"][index] ?? "";
  return ["X", "Y", "Z"][index] ?? "";
}

function vector2(x: number, y: number): TextAnimatorVector2Property {
  return [staticValue(x), staticValue(y)];
}

function vector3(x: number, y: number, z: number): TextAnimatorVector3Property {
  return [staticValue(x), staticValue(y), staticValue(z)];
}

function color(red: number, green: number, blue: number, alpha: number): TextAnimatorColorProperty {
  return [staticValue(red), staticValue(green), staticValue(blue), staticValue(alpha)];
}
