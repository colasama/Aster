import {
  evaluateTextAnimatorStack,
  type TextAnimatorStackSettings,
  type TextLayoutUnit,
} from "./text-animator-stack";
import { safeEvaluateTextSelectorExpression } from "./text-selector-expression";
import { staticValue } from "./types";

interface LegacyTextAnimatorSettings {
  enabled?: unknown;
  delay?: unknown;
  stagger?: unknown;
  duration?: unknown;
  position?: unknown;
  scale?: unknown;
  opacity?: unknown;
}

/** Deterministically upgrades Aster's legacy staggered reveal into an equivalent group. */
export function migrateLegacyTextAnimator(
  value: LegacyTextAnimatorSettings,
  idPrefix: string,
): TextAnimatorStackSettings {
  const delay = boundedNumber(value.delay, -60, 60, 0);
  const stagger = boundedNumber(value.stagger, 0, 10, 0.04);
  const duration = boundedNumber(value.duration, 0.01, 60, 0.5);
  const position = Array.isArray(value.position) ? value.position : [];
  const positionX = boundedNumber(position[0], -8192, 8192, 0);
  const positionY = boundedNumber(position[1], -8192, 8192, 64);
  const scale = boundedNumber(value.scale, 0, 1000, 80);
  const opacity = boundedNumber(value.opacity, 0, 100, 0);
  return {
    enabled: Boolean(value.enabled),
    groups: [
      {
        id: `${idPrefix}:animator:1`,
        name: "Animator 1",
        enabled: true,
        randomSeed: 0,
        selectors: [
          {
            id: `${idPrefix}:selector:1`,
            name: "Expression Selector 1",
            kind: "expression",
            enabled: true,
            mode: "add",
            amount: staticValue(100),
            basedOn: "characters",
            expression: legacyRevealExpression(delay, stagger, duration),
          },
        ],
        properties: {
          position: [staticValue(positionX), staticValue(positionY), staticValue(0)],
          scale: [staticValue(scale), staticValue(scale), staticValue(100)],
          opacity: staticValue(opacity),
        },
      },
    ],
  };
}

/** Evaluates an upgraded stack using the same bounded expression host as preview and export. */
export function evaluateMigratedTextAnimator(
  settings: TextAnimatorStackSettings,
  unit: TextLayoutUnit,
  time: number,
) {
  return evaluateTextAnimatorStack(settings.enabled ? settings.groups : [], unit, {
    time,
    evaluateExpression: safeEvaluateTextSelectorExpression,
    baseStyle: { codePoint: unit.codePoint },
  });
}

function legacyRevealExpression(delay: number, stagger: number, duration: number): string {
  return `100 * pow(1 - clamp((time - ${literal(delay)} - (textIndex - 1) * ${literal(stagger)}) / ${literal(duration)}, 0, 1), 3)`;
}

function literal(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(maximum, Math.max(minimum, number));
}
