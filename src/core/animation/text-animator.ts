import type { Animatable, TextAnimatorSettings } from "../types";
import {
  createDefaultTextAnimatorGroup,
  normalizeTextAnimatorGroups,
} from "./text-animator-groups";
import type { TextAnimatorProperties } from "./text-animator-stack";

export const MAX_ANIMATED_TEXT_CHARACTERS = 4096;

export function createDefaultTextAnimator(enabled = false): TextAnimatorSettings {
  return { enabled, groups: [createDefaultTextAnimatorGroup(0)] };
}

export function normalizeTextAnimatorSettings(
  settings: TextAnimatorSettings,
): TextAnimatorSettings {
  return {
    enabled: Boolean(settings.enabled),
    groups: normalizeTextAnimatorGroups(Array.isArray(settings.groups) ? settings.groups : []),
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

/** Returns a stable cache sample time, or undefined when a stack is fully time-invariant. */
export function clampTextAnimationTime(
  settings: TextAnimatorSettings | undefined,
  localTime: number,
  _characterCount?: number,
): number | undefined {
  if (!settings?.enabled) return undefined;
  const tracks: Animatable[] = [];
  for (const group of settings.groups) {
    if (!group.enabled) continue;
    for (const selector of group.selectors) {
      if (!selector.enabled) continue;
      if (selector.kind === "expression" || selector.kind === "wiggly") return finite(localTime);
      tracks.push(
        selector.amount,
        selector.start,
        selector.end,
        selector.offset,
        selector.smoothness,
        selector.easeHigh,
        selector.easeLow,
      );
    }
    collectPropertyTracks(group.properties, tracks);
  }
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const track of tracks) {
    if (track.mode !== "animated" || track.keyframes.length === 0) continue;
    first = Math.min(first, track.keyframes[0]?.time ?? first);
    last = Math.max(last, track.keyframes[track.keyframes.length - 1]?.time ?? last);
  }
  if (!Number.isFinite(first) || !Number.isFinite(last)) return undefined;
  return Math.min(last, Math.max(first, finite(localTime)));
}

function collectPropertyTracks(properties: TextAnimatorProperties, output: Animatable[]): void {
  for (const value of Object.values(properties)) {
    if (Array.isArray(value)) output.push(...value);
    else if (value && typeof value === "object" && "mode" in value) output.push(value);
  }
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
