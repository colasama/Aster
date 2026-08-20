import type { Operation, PropertyPath } from "./operations";
import type { Composition, Id, Keyframe } from "./types";

export type EditableKeyframe =
  | {
      source: "transform";
      layerId: Id;
      path: PropertyPath;
      keyframe: Keyframe;
    }
  | {
      source: "effect";
      layerId: Id;
      effectId: Id;
      parameter: string;
      keyframe: Keyframe;
    };

export interface KeyframeClipboard {
  anchorTime: number;
  entries: EditableKeyframe[];
}

type MoveKeyframeOperation = Extract<
  Operation,
  { type: "moveKeyframe" | "moveEffectParameterKeyframe" }
>;

const TRANSFORM_TRACKS = [
  "position.0",
  "position.1",
  "position.2",
  "rotation.0",
  "rotation.1",
  "rotation.2",
  "scale.0",
  "scale.1",
  "scale.2",
  "opacity",
] as const satisfies readonly PropertyPath[];

export function collectEditableKeyframes(composition: Composition): EditableKeyframe[] {
  return composition.layers.flatMap((layer) => {
    const transform = TRANSFORM_TRACKS.flatMap((path) => {
      const property = transformProperty(layer, path);
      return property.mode === "animated"
        ? property.keyframes.map((keyframe) => ({
            source: "transform" as const,
            layerId: layer.id,
            path,
            keyframe,
          }))
        : [];
    });
    const effects = layer.effects.flatMap((effect) =>
      Object.entries(effect.parameterKeyframes ?? {}).flatMap(([parameter, keyframes]) =>
        keyframes.map((keyframe) => ({
          source: "effect" as const,
          layerId: layer.id,
          effectId: effect.id,
          parameter,
          keyframe,
        })),
      ),
    );
    return [...transform, ...effects];
  });
}

export function selectedKeyframes(
  composition: Composition,
  selectedIds: Iterable<Id>,
): EditableKeyframe[] {
  const selected = new Set(selectedIds);
  return collectEditableKeyframes(composition).filter((entry) => selected.has(entry.keyframe.id));
}

export function copyKeyframes(entries: EditableKeyframe[]): KeyframeClipboard | undefined {
  if (!entries.length) return undefined;
  return {
    anchorTime: Math.min(...entries.map((entry) => entry.keyframe.time)),
    entries: structuredClone(entries),
  };
}

export function pasteKeyframes(
  clipboard: KeyframeClipboard,
  time: number,
  duration: number,
): { operations: Operation[]; selectedIds: Id[] } {
  const selectedIds: Id[] = [];
  const operations = clipboard.entries.map((entry) => {
    const id = crypto.randomUUID();
    selectedIds.push(id);
    const keyframe = {
      ...entry.keyframe,
      id,
      time: Math.min(duration, Math.max(0, time + entry.keyframe.time - clipboard.anchorTime)),
    };
    return entry.source === "transform"
      ? ({ type: "addKeyframe", layerId: entry.layerId, path: entry.path, keyframe } as const)
      : ({
          type: "addEffectParameterKeyframe",
          layerId: entry.layerId,
          effectId: entry.effectId,
          parameter: entry.parameter,
          keyframe,
        } as const);
  });
  return { operations, selectedIds };
}

export function removeKeyframes(entries: EditableKeyframe[]): Operation[] {
  return entries.map((entry) =>
    entry.source === "transform"
      ? {
          type: "removeKeyframe",
          layerId: entry.layerId,
          path: entry.path,
          keyframeId: entry.keyframe.id,
        }
      : {
          type: "removeEffectParameterKeyframe",
          layerId: entry.layerId,
          effectId: entry.effectId,
          parameter: entry.parameter,
          keyframeId: entry.keyframe.id,
        },
  );
}

export function retimeKeyframes(
  entries: EditableKeyframe[],
  activeId: Id,
  requestedTime: number,
  frameDuration: number,
  scale: boolean,
  snap = true,
  maximumTime = Number.POSITIVE_INFINITY,
): MoveKeyframeOperation[] {
  const active = entries.find((entry) => entry.keyframe.id === activeId);
  if (!active) return [];
  const snappedTime = snap ? snapToFrame(requestedTime, frameDuration) : Math.max(0, requestedTime);
  const earliest = Math.min(...entries.map((entry) => entry.keyframe.time));
  const latest = Math.max(...entries.map((entry) => entry.keyframe.time));
  const maximum = Number.isFinite(maximumTime)
    ? Math.max(0, maximumTime)
    : Number.POSITIVE_INFINITY;
  const activeDistance = active.keyframe.time - earliest;
  const selectedSpan = latest - earliest;
  const maximumFactor = selectedSpan > 0 ? (maximum - earliest) / selectedSpan : 1;
  const factor =
    scale && activeDistance > 0.000_001
      ? Math.max(0, Math.min(maximumFactor, (snappedTime - earliest) / activeDistance))
      : 1;
  const delta = Math.max(-earliest, Math.min(maximum - latest, snappedTime - active.keyframe.time));
  return entries.map((entry) => {
    const time =
      scale && activeDistance > 0.000_001
        ? earliest + (entry.keyframe.time - earliest) * factor
        : entry.keyframe.time + delta;
    return moveOperation(entry, Math.max(0, Math.min(maximum, time)));
  });
}

function moveOperation(entry: EditableKeyframe, time: number): MoveKeyframeOperation {
  return entry.source === "transform"
    ? {
        type: "moveKeyframe",
        layerId: entry.layerId,
        path: entry.path,
        keyframeId: entry.keyframe.id,
        time,
      }
    : {
        type: "moveEffectParameterKeyframe",
        layerId: entry.layerId,
        effectId: entry.effectId,
        parameter: entry.parameter,
        keyframeId: entry.keyframe.id,
        time,
      };
}

function snapToFrame(time: number, frameDuration: number): number {
  if (!Number.isFinite(frameDuration) || frameDuration <= 0) return Math.max(0, time);
  return Math.max(0, Math.round(time / frameDuration) * frameDuration);
}

function transformProperty(layer: Composition["layers"][number], path: PropertyPath) {
  if (path === "opacity") return layer.transform.opacity;
  const [group, component] = path.split(".") as [
    "position" | "rotation" | "scale",
    "0" | "1" | "2",
  ];
  return layer.transform[group][Number(component)];
}
