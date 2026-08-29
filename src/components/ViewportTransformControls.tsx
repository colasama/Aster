import {
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getProperty, type Operation, type PropertyPath } from "../core/operations";
import { evaluateWorldTransform, visibleLayersAtTime } from "../core/scene-evaluation";
import { evaluateAnimatable } from "../core/timeline";
import {
  type Composition,
  createId,
  type EvaluatedTransform,
  type Layer,
  type Project,
} from "../core/types";
import { useI18n } from "../i18n/react";
import type { EditorAction, EditorState } from "../state/editor-store";
import {
  compositionToLocal,
  localToComposition,
  moveAnchorPreservingGeometry,
  moveViewportSelection,
  type Point2,
  resizeViewportSelection,
  rotateViewportSelectionFromPointer,
  ViewportPreviewCoalescer,
  type ViewportResizeHandle,
  type ViewportSelectionMember,
  type ViewportSnapTarget,
  type ViewportTransform2d,
  viewportSelectionBounds,
  viewportSnapTargets,
  viewportTransformBounds,
} from "../viewport/transform-interaction";

interface ViewportTransformControlsProps {
  readonly activeTool: EditorState["activeTool"];
  readonly composition: Composition;
  readonly dispatch: Dispatch<EditorAction>;
  readonly onEditText: (layerId: string) => void;
  readonly project: Project;
  readonly selection: readonly string[];
  readonly showGuides: boolean;
  readonly time: number;
  readonly zoom: number;
}

interface ControlMember extends ViewportSelectionMember {
  readonly layer: Layer;
  readonly world: EvaluatedTransform;
}

type GestureMode = "move" | "resize" | "rotate" | "anchor";

interface TransformGesture {
  readonly pointerId: number;
  readonly pointerTarget: SVGElement;
  readonly mode: GestureMode;
  readonly handle?: ViewportResizeHandle;
  readonly start: Point2;
  readonly initial: readonly ControlMember[];
  readonly historyBase: Project;
  readonly keyframeIds: Map<string, string>;
  latest?: readonly ViewportSelectionMember[];
  operations?: Operation[];
}

const HANDLES: readonly ViewportResizeHandle[] = [
  "northWest",
  "north",
  "northEast",
  "east",
  "southEast",
  "south",
  "southWest",
  "west",
];

const POSITION_PATHS = ["position.0", "position.1"] as const;
const SCALE_PATHS = ["scale.0", "scale.1"] as const;
const ROTATION_PATHS = ["rotation.2"] as const;
const ANCHOR_PATHS = ["anchor.0", "anchor.1"] as const;

export function ViewportTransformControls({
  activeTool,
  composition,
  dispatch,
  onEditText,
  project,
  selection,
  showGuides,
  time,
  zoom,
}: ViewportTransformControlsProps) {
  const { t } = useI18n();
  const svgRef = useRef<SVGSVGElement>(null);
  const gestureRef = useRef<TransformGesture | undefined>(undefined);
  const coalescerRef = useRef<ViewportPreviewCoalescer<Operation[]> | undefined>(undefined);
  const [snapped, setSnapped] = useState<readonly ViewportSnapTarget[]>([]);
  const members = useMemo(
    () => buildControlMembers(composition, selection, time),
    [composition, selection, time],
  );
  const editable = useMemo(() => topLevelEditableMembers(members), [members]);
  const bounds = viewportSelectionBounds(editable);
  const snapTargets = useMemo(
    () => buildSnapTargets(composition, selection, time, showGuides),
    [composition, selection, showGuides, time],
  );

  const cancelActiveGesture = useCallback(
    (pointerId?: number) => {
      const gesture = gestureRef.current;
      if (!gesture || (pointerId !== undefined && gesture.pointerId !== pointerId)) return false;
      gestureRef.current = undefined;
      setSnapped([]);
      coalescerRef.current?.cancel();
      coalescerRef.current = undefined;
      if (gesture.pointerTarget.hasPointerCapture(gesture.pointerId))
        gesture.pointerTarget.releasePointerCapture(gesture.pointerId);
      if (gesture.operations)
        dispatch({
          type: "previewOperation",
          operations: cancelGestureOperations(
            gesture.initial,
            operationPaths(gesture.mode, gesture.initial.length),
            time,
            gesture.keyframeIds,
          ),
        });
      return true;
    },
    [dispatch, time],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !cancelActiveGesture()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onBlur = () => cancelActiveGesture();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [cancelActiveGesture]);

  useEffect(() => () => void cancelActiveGesture(), [cancelActiveGesture]);

  if (members.length === 0) return null;
  const groupLabel =
    members.length === 1
      ? t("viewport.transformLayer", { name: members[0]?.layer.name ?? "" })
      : t("viewport.transformSelection", { count: members.length });
  const handlePoints = editable.length > 0 ? selectionHandlePoints(editable) : undefined;
  const rotationGeometry =
    editable.length > 0 ? selectionRotationGeometry(editable, zoom) : undefined;
  const anchorPoint =
    editable.length === 1 && editable[0]
      ? scalePoint(editable[0].transform.position, zoom)
      : undefined;

  const operationsFor = (
    next: readonly ViewportSelectionMember[],
    mode: GestureMode,
    keyframeIds: Map<string, string>,
    sourceMembers: readonly ControlMember[] = editable,
  ): Operation[] => {
    const fields = operationPaths(mode, next.length);
    return next.flatMap((entry) => {
      const initial = sourceMembers.find((candidate) => candidate.id === entry.id);
      if (!initial) return [];
      const local = worldToLocalTransform(initial.layer, entry.transform, composition, time);
      return fields.flatMap((path): Operation[] => {
        const value = transformPathValue(local, path);
        if (Math.abs(evaluateAnimatable(getProperty(initial.layer, path), time) - value) < 1e-6)
          return [];
        return [propertyValueOperation(initial.layer, path, value, time, keyframeIds)];
      });
    });
  };

  const beginGesture = (
    event: ReactPointerEvent<SVGElement>,
    mode: GestureMode,
    handle?: ViewportResizeHandle,
  ) => {
    if (editable.length === 0 || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = pointerInComposition(event, svgRef.current, zoom);
    const gesture: TransformGesture = {
      pointerId: event.pointerId,
      pointerTarget: event.currentTarget,
      mode,
      handle,
      start,
      initial: editable,
      historyBase: project,
      keyframeIds: new Map(),
    };
    gestureRef.current = gesture;
    coalescerRef.current?.cancel();
    coalescerRef.current = new ViewportPreviewCoalescer((operations) => {
      gesture.operations = operations;
      dispatch({ type: "previewOperation", operations });
    });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateGesture = (event: ReactPointerEvent<SVGElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    const pointer = pointerInComposition(event, svgRef.current, zoom);
    let next: readonly ViewportSelectionMember[];
    if (gesture.mode === "move") {
      const result = moveViewportSelection(
        gesture.initial,
        [pointer[0] - gesture.start[0], pointer[1] - gesture.start[1]],
        event.ctrlKey || event.metaKey ? [] : snapTargets,
        7,
        zoom,
      );
      next = result.members;
      setSnapped(result.snapped);
    } else if (gesture.mode === "resize" && gesture.handle) {
      next = resizeViewportSelection(gesture.initial, gesture.handle, pointer, {
        fromAnchor: event.altKey,
        preserveAspectRatio: event.shiftKey,
        minimumScale: 0.01,
      });
      setSnapped([]);
    } else if (gesture.mode === "rotate") {
      next = rotateViewportSelectionFromPointer(
        gesture.initial,
        gesture.start,
        pointer,
        event.shiftKey ? 15 : 0,
      );
      setSnapped([]);
    } else {
      const member = gesture.initial[0];
      next = member
        ? [
            {
              ...member,
              transform: moveAnchorPreservingGeometry(
                member.transform,
                compositionToLocal(pointer, member.transform),
              ),
            },
          ]
        : gesture.initial;
      setSnapped([]);
    }
    gesture.latest = next;
    coalescerRef.current?.update(
      operationsFor(next, gesture.mode, gesture.keyframeIds, gesture.initial),
    );
  };

  const finishGesture = (event: ReactPointerEvent<SVGElement>, cancelled: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (cancelled || !gesture.latest || selectionMembersEqual(gesture.initial, gesture.latest)) {
      cancelActiveGesture(event.pointerId);
      return;
    }
    gestureRef.current = undefined;
    setSnapped([]);
    if (gesture.pointerTarget.hasPointerCapture(gesture.pointerId))
      gesture.pointerTarget.releasePointerCapture(gesture.pointerId);
    coalescerRef.current?.flush();
    coalescerRef.current = undefined;
    const operations = operationsFor(
      gesture.latest,
      gesture.mode,
      gesture.keyframeIds,
      gesture.initial,
    );
    dispatch({ type: "operation", historyBase: gesture.historyBase, operations });
  };

  const keyboardMove = (event: ReactKeyboardEvent<SVGElement>) => {
    if (!event.key.startsWith("Arrow") || editable.length === 0) return;
    event.preventDefault();
    const amount = event.shiftKey ? 10 : 1;
    const delta: Point2 = [
      event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0,
      event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0,
    ];
    const next = moveViewportSelection(editable, delta).members;
    dispatch({
      type: "operation",
      operations: operationsFor(next, "move", new Map()),
    });
  };

  const interactionProps = (mode: GestureMode, handle?: ViewportResizeHandle) => ({
    onLostPointerCapture: (event: ReactPointerEvent<SVGElement>) =>
      cancelActiveGesture(event.pointerId),
    onPointerCancel: (event: ReactPointerEvent<SVGElement>) => {
      event.preventDefault();
      cancelActiveGesture(event.pointerId);
    },
    onPointerDown: (event: ReactPointerEvent<SVGElement>) => beginGesture(event, mode, handle),
    onPointerMove: updateGesture,
    onPointerUp: (event: ReactPointerEvent<SVGElement>) => finishGesture(event, false),
  });

  return (
    <svg
      aria-label={groupLabel}
      className="viewport-transform-controls"
      height={composition.height * zoom}
      ref={svgRef}
      viewBox={`0 0 ${composition.width * zoom} ${composition.height * zoom}`}
      width={composition.width * zoom}
    >
      {snapped.map((target) =>
        target.axis === "x" ? (
          <line
            className="viewport-snap-line"
            key={`${target.axis}-${target.id}`}
            x1={target.value * zoom}
            x2={target.value * zoom}
            y1={0}
            y2={composition.height * zoom}
          />
        ) : (
          <line
            className="viewport-snap-line"
            key={`${target.axis}-${target.id}`}
            x1={0}
            x2={composition.width * zoom}
            y1={target.value * zoom}
            y2={target.value * zoom}
          />
        ),
      )}
      {members.map((member) => (
        <polygon
          className={`viewport-selection-outline ${member.layer.locked ? "locked" : ""}`}
          key={member.id}
          points={polygonPoints(member.transform, zoom)}
        />
      ))}
      {editable.length > 1 && bounds ? (
        <rect
          className="viewport-selection-group-outline"
          height={(bounds.bottom - bounds.top) * zoom}
          width={(bounds.right - bounds.left) * zoom}
          x={bounds.left * zoom}
          y={bounds.top * zoom}
        />
      ) : null}
      {editable.length > 0 ? (
        editable.length === 1 && editable[0] ? (
          // biome-ignore lint/a11y/useSemanticElements: SVG geometry must match the transformed layer polygon.
          <polygon
            {...interactionProps(activeTool === "rotate" ? "rotate" : "move")}
            aria-label={groupLabel}
            className="viewport-selection-hit"
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (editable[0]?.layer.kind === "text") onEditText(editable[0].layer.id);
            }}
            onKeyDown={keyboardMove}
            points={polygonPoints(editable[0].transform, zoom)}
            role="button"
            tabIndex={0}
          />
        ) : bounds ? (
          // biome-ignore lint/a11y/useSemanticElements: SVG geometry must match the multi-selection bounds.
          <rect
            {...interactionProps(activeTool === "rotate" ? "rotate" : "move")}
            aria-label={groupLabel}
            className="viewport-selection-hit"
            height={(bounds.bottom - bounds.top) * zoom}
            onKeyDown={keyboardMove}
            role="button"
            tabIndex={0}
            width={(bounds.right - bounds.left) * zoom}
            x={bounds.left * zoom}
            y={bounds.top * zoom}
          />
        ) : null
      ) : null}
      {rotationGeometry ? (
        <>
          <line
            className="viewport-rotation-stem"
            x1={rotationGeometry.stem[0]}
            x2={rotationGeometry.handle[0]}
            y1={rotationGeometry.stem[1]}
            y2={rotationGeometry.handle[1]}
          />
          {/* biome-ignore lint/a11y/useSemanticElements: The rotation control is positioned in the SVG coordinate system. */}
          <circle
            {...interactionProps("rotate")}
            aria-label={t("viewport.rotateSelection")}
            className="viewport-rotation-handle"
            cx={rotationGeometry.handle[0]}
            cy={rotationGeometry.handle[1]}
            r={5}
            role="button"
            tabIndex={0}
          />
        </>
      ) : null}
      {handlePoints
        ? HANDLES.map((handle) => {
            const point = handlePoints[handle];
            return (
              // biome-ignore lint/a11y/useSemanticElements: Resize handles must stay in the SVG coordinate system.
              <rect
                {...interactionProps("resize", handle)}
                aria-label={t("viewport.resizeSelection", {
                  handle: t(`viewport.handle.${handle}`),
                })}
                className={`viewport-resize-handle ${handle}`}
                height={8}
                key={handle}
                role="button"
                tabIndex={0}
                width={8}
                x={point[0] * zoom - 4}
                y={point[1] * zoom - 4}
              />
            );
          })
        : null}
      {anchorPoint ? (
        // biome-ignore lint/a11y/useSemanticElements: The anchor control must stay in the SVG coordinate system.
        <rect
          {...interactionProps("anchor")}
          aria-label={t("viewport.moveAnchor")}
          className="viewport-anchor-handle"
          height={8}
          role="button"
          tabIndex={0}
          transform={`rotate(45 ${anchorPoint[0]} ${anchorPoint[1]})`}
          width={8}
          x={anchorPoint[0] - 4}
          y={anchorPoint[1] - 4}
        />
      ) : null}
      {editable.length === 0 ? <title>{t("viewport.selectionLocked")}</title> : null}
    </svg>
  );
}

function buildControlMembers(
  composition: Composition,
  selection: readonly string[],
  time: number,
): ControlMember[] {
  const visible = new Set(visibleLayersAtTime(composition, time).map((layer) => layer.id));
  const selectionOrder = new Map(selection.map((id, index) => [id, index]));
  return composition.layers
    .filter(
      (layer) =>
        selectionOrder.has(layer.id) &&
        visible.has(layer.id) &&
        !layer.threeDimensional &&
        layer.kind !== "audio" &&
        layer.kind !== "camera" &&
        layer.kind !== "light" &&
        layer.kind !== "adjustment",
    )
    .sort((left, right) => (selectionOrder.get(left.id) ?? 0) - (selectionOrder.get(right.id) ?? 0))
    .map((layer) => {
      const world = evaluateWorldTransform(layer, composition, time);
      return {
        id: layer.id,
        layer,
        world,
        transform: {
          position: [world.position[0], world.position[1]],
          scale: [world.scale[0], world.scale[1]],
          rotation: world.rotation[2],
          anchor: [world.anchor[0], world.anchor[1]],
          size: layer.size,
        },
      };
    });
}

function topLevelEditableMembers(members: readonly ControlMember[]): ControlMember[] {
  const editableIds = new Set(members.filter((member) => !member.layer.locked).map(({ id }) => id));
  const layers = new Map(members.map((member) => [member.id, member.layer]));
  return members.filter((member) => {
    if (member.layer.locked) return false;
    let parentId = member.layer.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      if (editableIds.has(parentId)) return false;
      visited.add(parentId);
      parentId = layers.get(parentId)?.parentId;
    }
    return true;
  });
}

function buildSnapTargets(
  composition: Composition,
  selection: readonly string[],
  time: number,
  showGuides: boolean,
): readonly ViewportSnapTarget[] {
  const selected = new Set(selection);
  const layerBounds = visibleLayersAtTime(composition, time)
    .filter(
      (layer) =>
        !selected.has(layer.id) &&
        !layer.threeDimensional &&
        layer.kind !== "audio" &&
        layer.kind !== "camera" &&
        layer.kind !== "light" &&
        layer.kind !== "adjustment",
    )
    .map((layer) => {
      const world = evaluateWorldTransform(layer, composition, time);
      return {
        id: layer.id,
        ...viewportTransformBounds({
          position: [world.position[0], world.position[1]],
          scale: [world.scale[0], world.scale[1]],
          rotation: world.rotation[2],
          anchor: [world.anchor[0], world.anchor[1]],
          size: layer.size,
        }),
      };
    });
  return viewportSnapTargets(
    [composition.width, composition.height],
    showGuides
      ? {
          vertical: [
            composition.width * 0.05,
            composition.width * 0.1,
            composition.width * 0.9,
            composition.width * 0.95,
          ],
          horizontal: [
            composition.height * 0.05,
            composition.height * 0.1,
            composition.height * 0.9,
            composition.height * 0.95,
          ],
        }
      : {},
    layerBounds,
  );
}

function selectionHandlePoints(
  members: readonly ViewportSelectionMember[],
): Record<ViewportResizeHandle, Point2> | undefined {
  const member = members.length === 1 ? members[0] : undefined;
  if (member) {
    const { size, transform } = { size: member.transform.size, transform: member.transform };
    return {
      northWest: localToComposition([0, 0], transform),
      north: localToComposition([size[0] * 0.5, 0], transform),
      northEast: localToComposition([size[0], 0], transform),
      east: localToComposition([size[0], size[1] * 0.5], transform),
      southEast: localToComposition([size[0], size[1]], transform),
      south: localToComposition([size[0] * 0.5, size[1]], transform),
      southWest: localToComposition([0, size[1]], transform),
      west: localToComposition([0, size[1] * 0.5], transform),
    };
  }
  const bounds = viewportSelectionBounds(members);
  if (!bounds) return undefined;
  const centerX = (bounds.left + bounds.right) * 0.5;
  const centerY = (bounds.top + bounds.bottom) * 0.5;
  return {
    northWest: [bounds.left, bounds.top],
    north: [centerX, bounds.top],
    northEast: [bounds.right, bounds.top],
    east: [bounds.right, centerY],
    southEast: [bounds.right, bounds.bottom],
    south: [centerX, bounds.bottom],
    southWest: [bounds.left, bounds.bottom],
    west: [bounds.left, centerY],
  };
}

function selectionRotationGeometry(
  members: readonly ViewportSelectionMember[],
  zoom: number,
): { readonly stem: Point2; readonly handle: Point2 } | undefined {
  const points = selectionHandlePoints(members);
  const bounds = viewportSelectionBounds(members);
  if (!points || !bounds) return undefined;
  const stem = points.north;
  const center: Point2 =
    members.length === 1 && members[0]
      ? members[0].transform.position
      : [(bounds.left + bounds.right) * 0.5, (bounds.top + bounds.bottom) * 0.5];
  const vector: Point2 = [stem[0] - center[0], stem[1] - center[1]];
  const length = Math.hypot(vector[0], vector[1]);
  const direction: Point2 = length > 1e-4 ? [vector[0] / length, vector[1] / length] : [0, -1];
  const offset = 26 / Math.max(zoom, 1e-4);
  return {
    stem: scalePoint(stem, zoom),
    handle: scalePoint([stem[0] + direction[0] * offset, stem[1] + direction[1] * offset], zoom),
  };
}

function worldToLocalTransform(
  layer: Layer,
  desired: ViewportTransform2d,
  composition: Composition,
  time: number,
): ViewportTransform2d {
  if (!layer.parentId) return desired;
  const parent = composition.layers.find((candidate) => candidate.id === layer.parentId);
  if (!parent) return desired;
  const world = evaluateWorldTransform(parent, composition, time);
  const radians = (-world.rotation[2] * Math.PI) / 180;
  const deltaX = desired.position[0] - world.position[0];
  const deltaY = desired.position[1] - world.position[1];
  const rotatedX = deltaX * Math.cos(radians) - deltaY * Math.sin(radians);
  const rotatedY = deltaX * Math.sin(radians) + deltaY * Math.cos(radians);
  return {
    ...desired,
    position: [
      rotatedX / safeScale(world.scale[0] / 100),
      rotatedY / safeScale(world.scale[1] / 100),
    ],
    rotation: desired.rotation - world.rotation[2],
    scale: [
      (desired.scale[0] / safeScale(world.scale[0])) * 100,
      (desired.scale[1] / safeScale(world.scale[1])) * 100,
    ],
  };
}

function propertyValueOperation(
  layer: Layer,
  path: PropertyPath,
  value: number,
  time: number,
  keyframeIds: Map<string, string>,
): Operation {
  const property = getProperty(layer, path);
  if (property.mode === "static") return { type: "setProperty", layerId: layer.id, path, value };
  const current = property.keyframes.find((keyframe) => Math.abs(keyframe.time - time) <= 1e-6);
  const key = `${layer.id}:${path}`;
  const id = current?.id ?? keyframeIds.get(key) ?? createId();
  keyframeIds.set(key, id);
  return {
    type: "addKeyframe",
    layerId: layer.id,
    path,
    keyframe: {
      id,
      time,
      value,
      interpolation: current?.interpolation ?? "linear",
      ...(current?.easing ? { easing: current.easing } : {}),
      ...(current?.spatialIn !== undefined ? { spatialIn: current.spatialIn } : {}),
      ...(current?.spatialOut !== undefined ? { spatialOut: current.spatialOut } : {}),
    },
  };
}

function cancelGestureOperations(
  members: readonly ControlMember[],
  paths: readonly PropertyPath[],
  time: number,
  keyframeIds: ReadonlyMap<string, string>,
): Operation[] {
  return members.flatMap((member) =>
    paths.flatMap((path): Operation[] => {
      const property = getProperty(member.layer, path);
      if (property.mode === "static")
        return [
          {
            type: "setProperty",
            layerId: member.id,
            path,
            value: evaluateAnimatable(property, time),
          },
        ];
      const current = property.keyframes.find((keyframe) => Math.abs(keyframe.time - time) <= 1e-6);
      if (current) return [{ type: "addKeyframe", layerId: member.id, path, keyframe: current }];
      const id = keyframeIds.get(`${member.id}:${path}`);
      return id ? [{ type: "removeKeyframe", layerId: member.id, path, keyframeId: id }] : [];
    }),
  );
}

function operationPaths(mode: GestureMode, memberCount: number): readonly PropertyPath[] {
  if (mode === "move") return POSITION_PATHS;
  if (mode === "resize") return [...POSITION_PATHS, ...SCALE_PATHS];
  if (mode === "rotate")
    return memberCount > 1 ? [...POSITION_PATHS, ...ROTATION_PATHS] : ROTATION_PATHS;
  return [...POSITION_PATHS, ...ANCHOR_PATHS];
}

function transformPathValue(transform: ViewportTransform2d, path: PropertyPath): number {
  if (path === "position.0") return transform.position[0];
  if (path === "position.1") return transform.position[1];
  if (path === "scale.0") return transform.scale[0];
  if (path === "scale.1") return transform.scale[1];
  if (path === "rotation.2") return transform.rotation;
  if (path === "anchor.0") return transform.anchor[0];
  if (path === "anchor.1") return transform.anchor[1];
  throw new Error(`Unsupported viewport transform property: ${path}`);
}

function pointerInComposition(
  event: ReactPointerEvent<SVGElement>,
  svg: SVGSVGElement | null,
  zoom: number,
): Point2 {
  const bounds = svg?.getBoundingClientRect();
  return bounds
    ? [(event.clientX - bounds.left) / zoom, (event.clientY - bounds.top) / zoom]
    : [event.clientX / zoom, event.clientY / zoom];
}

function polygonPoints(transform: ViewportTransform2d, zoom: number): string {
  return [
    localToComposition([0, 0], transform),
    localToComposition([transform.size[0], 0], transform),
    localToComposition(transform.size, transform),
    localToComposition([0, transform.size[1]], transform),
  ]
    .map((point) => `${point[0] * zoom},${point[1] * zoom}`)
    .join(" ");
}

function selectionMembersEqual(
  before: readonly ViewportSelectionMember[],
  after: readonly ViewportSelectionMember[],
): boolean {
  return before.every((member, index) => {
    const next = after[index]?.transform;
    if (!next) return false;
    return (
      Math.hypot(
        member.transform.position[0] - next.position[0],
        member.transform.position[1] - next.position[1],
        member.transform.scale[0] - next.scale[0],
        member.transform.scale[1] - next.scale[1],
        member.transform.anchor[0] - next.anchor[0],
        member.transform.anchor[1] - next.anchor[1],
        member.transform.rotation - next.rotation,
      ) < 1e-5
    );
  });
}

function scalePoint(point: Point2, scale: number): Point2 {
  return [point[0] * scale, point[1] * scale];
}

function safeScale(value: number): number {
  if (Math.abs(value) >= 1e-6) return value;
  return value < 0 ? -1e-6 : 1e-6;
}
