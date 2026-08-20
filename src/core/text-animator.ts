import type { TextAnimatorSettings } from "./types";

export const MAX_ANIMATED_TEXT_CHARACTERS = 4096;

export const TEXT_ANIMATOR_LIMITS = {
  delay: [-60, 60],
  stagger: [0, 10],
  duration: [0.01, 60],
  position: [-8192, 8192],
  scale: [0, 1000],
  opacity: [0, 100],
} as const;

export interface EvaluatedTextCharacter {
  position: [number, number];
  scale: number;
  opacity: number;
  progress: number;
}

export function createDefaultTextAnimator(enabled = false): TextAnimatorSettings {
  return {
    enabled,
    delay: 0,
    stagger: 0.04,
    duration: 0.5,
    position: [0, 64],
    scale: 80,
    opacity: 0,
  };
}

export function normalizeTextAnimatorSettings(
  settings: TextAnimatorSettings,
): TextAnimatorSettings {
  return {
    enabled: Boolean(settings.enabled),
    delay: bounded(settings.delay, ...TEXT_ANIMATOR_LIMITS.delay),
    stagger: bounded(settings.stagger, ...TEXT_ANIMATOR_LIMITS.stagger),
    duration: bounded(settings.duration, ...TEXT_ANIMATOR_LIMITS.duration),
    position: settings.position.map((value) =>
      bounded(value, ...TEXT_ANIMATOR_LIMITS.position),
    ) as [number, number],
    scale: bounded(settings.scale, ...TEXT_ANIMATOR_LIMITS.scale),
    opacity: bounded(settings.opacity, ...TEXT_ANIMATOR_LIMITS.opacity),
  };
}

export function evaluateTextCharacter(
  settings: TextAnimatorSettings | undefined,
  localTime: number,
  characterIndex: number,
): EvaluatedTextCharacter {
  const index = Math.max(0, Math.floor(finite(characterIndex)));
  if (!settings?.enabled || index >= MAX_ANIMATED_TEXT_CHARACTERS)
    return { position: [0, 0], scale: 1, opacity: 1, progress: 1 };
  const delay = bounded(settings.delay, ...TEXT_ANIMATOR_LIMITS.delay);
  const stagger = bounded(settings.stagger, ...TEXT_ANIMATOR_LIMITS.stagger);
  const duration = bounded(settings.duration, ...TEXT_ANIMATOR_LIMITS.duration);
  const linearProgress = clamp01((finite(localTime) - delay - index * stagger) / duration);
  const remaining = 1 - easeOutCubic(linearProgress);
  const positionX = bounded(settings.position[0], ...TEXT_ANIMATOR_LIMITS.position);
  const positionY = bounded(settings.position[1], ...TEXT_ANIMATOR_LIMITS.position);
  const scale = bounded(settings.scale, ...TEXT_ANIMATOR_LIMITS.scale);
  const opacity = bounded(settings.opacity, ...TEXT_ANIMATOR_LIMITS.opacity);
  return {
    position: [positionX * remaining, positionY * remaining],
    scale: (100 + (scale - 100) * remaining) / 100,
    opacity: (100 + (opacity - 100) * remaining) / 100,
    progress: 1 - remaining,
  };
}

export function countAnimatedTextCharacters(text: string): number {
  let count = 0;
  for (const _segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    count += 1;
    if (count >= MAX_ANIMATED_TEXT_CHARACTERS) break;
  }
  return count;
}

export function clampTextAnimationTime(
  settings: TextAnimatorSettings | undefined,
  localTime: number,
  characterCount: number,
): number | undefined {
  if (!settings?.enabled) return undefined;
  const normalized = normalizeTextAnimatorSettings(settings);
  const boundedCount = Math.max(
    0,
    Math.min(MAX_ANIMATED_TEXT_CHARACTERS, Math.floor(finite(characterCount))),
  );
  const end =
    normalized.delay + Math.max(0, boundedCount - 1) * normalized.stagger + normalized.duration;
  return Math.max(Math.min(finite(localTime), Math.max(0, end)), Math.min(0, end));
}

function easeOutCubic(value: number): number {
  return 1 - (1 - value) ** 3;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finite(value)));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
