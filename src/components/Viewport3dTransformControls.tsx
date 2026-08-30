import {
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { createDefaultEvaluatedCamera } from "../core/camera-settings";
import { getProperty, type Operation } from "../core/operations";
import { propertyValueOperationAtTime } from "../core/property-edit-operation";
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
import { evaluateSceneCamera } from "../renderer/scene-camera";
import type { EditorAction } from "../state/editor-store";
import {
  axisConstrainedWorldDelta,
  type ProjectedGizmoAxis3d,
  projectedGizmoAxes3d,
  projectLayerBounds3d,
  type TransformSpace3d,
  viewPlaneWorldDelta,
  worldPositionToLayerPosition,
} from "../viewport/transform-3d-interaction";
import { ViewportPreviewCoalescer } from "../viewport/transform-interaction";

interface Viewport3dTransformControlsProps {
  readonly composition: Composition;
  readonly dispatch: Dispatch<EditorAction>;
  readonly project: Project;
  readonly selection: readonly string[];
  readonly space: TransformSpace3d;
  readonly time: number;
  readonly zoom: number;
}

interface ControlMember3d {
  readonly layer: Layer;
  readonly world: EvaluatedTransform;
}

interface TransformGesture3d {
  readonly pointerId: number;
  readonly pointerTarget: SVGElement;
  readonly start: readonly [number, number];
  readonly initial: readonly ControlMember3d[];
  readonly origin: readonly [number, number, number];
  readonly axis?: ProjectedGizmoAxis3d;
  readonly historyBase: Project;
  readonly keyframeIds: Map<string, string>;
  latestDelta?: readonly [number, number, number];
  operations?: Operation[];
}

const POSITION_PATHS = ["position.0", "position.1", "position.2"] as const;

export function Viewport3dTransformControls({
  composition,
  dispatch,
  project,
  selection,
  space,
  time,
  zoom,
}: Viewport3dTransformControlsProps) {
  const { t } = useI18n();
  const svgRef = useRef<SVGSVGElement>(null);
  const gestureRef = useRef<TransformGesture3d | undefined>(undefined);
  const coalescerRef = useRef<ViewportPreviewCoalescer<Operation[]> | undefined>(undefined);
  const camera = useMemo(
    () =>
      evaluateSceneCamera(composition, time) ??
      createDefaultEvaluatedCamera(composition.width, composition.height),
    [composition, time],
  );
  const members = useMemo(
    () => buildControlMembers3d(composition, selection, time),
    [composition, selection, time],
  );
  const editable = useMemo(() => topLevelEditableMembers3d(members), [members]);
  const projected = useMemo(
    () =>
      members.flatMap((member) => {
        const bounds = projectLayerBounds3d(member.layer, member.world, composition, camera);
        return bounds ? [{ ...member, bounds }] : [];
      }),
    [camera, composition, members],
  );
  const origin = averageWorldPosition(editable);
  const axes = useMemo(() => {
    const orientationSource = editable[0];
    if (!orientationSource || !origin) return [];
    return projectedGizmoAxes3d(
      { ...orientationSource.world, position: [...origin] },
      composition,
      camera,
      space,
      zoom,
    );
  }, [camera, composition, editable, origin, space, zoom]);

  const operationsFor = useCallback(
    (
      sourceMembers: readonly ControlMember3d[],
      delta: readonly [number, number, number],
      keyframeIds: Map<string, string>,
    ): Operation[] =>
      sourceMembers.flatMap((member) => {
        const local = worldPositionToLayerPosition(
          member.layer,
          [
            member.world.position[0] + delta[0],
            member.world.position[1] + delta[1],
            member.world.position[2] + delta[2],
          ],
          composition,
          time,
        );
        return POSITION_PATHS.flatMap((path, axis): Operation[] => {
          const property = getProperty(member.layer, path);
          const value = local[axis] ?? 0;
          if (Math.abs(evaluateAnimatable(property, time) - value) < 0.000001) return [];
          const key = `${member.layer.id}:${path}`;
          const id = keyframeIds.get(key) ?? createId();
          keyframeIds.set(key, id);
          return [propertyValueOperationAtTime(member.layer, path, value, time, id)];
        });
      }),
    [composition, time],
  );

  const cancelActiveGesture = useCallback(
    (pointerId?: number) => {
      const gesture = gestureRef.current;
      if (!gesture || (pointerId !== undefined && gesture.pointerId !== pointerId)) return false;
      gestureRef.current = undefined;
      coalescerRef.current?.cancel();
      coalescerRef.current = undefined;
      if (gesture.pointerTarget.hasPointerCapture(gesture.pointerId))
        gesture.pointerTarget.releasePointerCapture(gesture.pointerId);
      if (gesture.operations)
        dispatch({
          type: "previewOperation",
          operations: cancelPositionOperations(gesture.initial, time, gesture.keyframeIds),
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

  if (members.length === 0 || projected.length === 0) return null;
  const label =
    members.length === 1
      ? t("viewport.transformLayer", { name: members[0]?.layer.name ?? "" })
      : t("viewport.transformSelection", { count: members.length });

  const beginGesture = (event: ReactPointerEvent<SVGElement>, axis?: ProjectedGizmoAxis3d) => {
    if (editable.length === 0 || !origin || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const gesture: TransformGesture3d = {
      pointerId: event.pointerId,
      pointerTarget: event.currentTarget,
      start: pointerInComposition(event, svgRef.current, zoom),
      initial: editable,
      origin,
      axis,
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
    const pointerDelta: [number, number] = [
      pointer[0] - gesture.start[0],
      pointer[1] - gesture.start[1],
    ];
    const delta = gesture.axis
      ? axisConstrainedWorldDelta(pointerDelta, gesture.axis)
      : viewPlaneWorldDelta([...gesture.start], pointer, [...gesture.origin], composition, camera);
    gesture.latestDelta = delta;
    coalescerRef.current?.update(operationsFor(gesture.initial, delta, gesture.keyframeIds));
  };

  const finishGesture = (event: ReactPointerEvent<SVGElement>, cancelled: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (cancelled || !gesture.latestDelta || vectorNearZero(gesture.latestDelta)) {
      cancelActiveGesture(event.pointerId);
      return;
    }
    gestureRef.current = undefined;
    if (gesture.pointerTarget.hasPointerCapture(gesture.pointerId))
      gesture.pointerTarget.releasePointerCapture(gesture.pointerId);
    coalescerRef.current?.flush();
    coalescerRef.current = undefined;
    dispatch({
      type: "operation",
      historyBase: gesture.historyBase,
      operations: operationsFor(gesture.initial, gesture.latestDelta, gesture.keyframeIds),
    });
  };

  const interactionProps = (axis?: ProjectedGizmoAxis3d) => ({
    onLostPointerCapture: (event: ReactPointerEvent<SVGElement>) =>
      cancelActiveGesture(event.pointerId),
    onPointerCancel: (event: ReactPointerEvent<SVGElement>) => {
      event.preventDefault();
      cancelActiveGesture(event.pointerId);
    },
    onPointerDown: (event: ReactPointerEvent<SVGElement>) => beginGesture(event, axis),
    onPointerMove: updateGesture,
    onPointerUp: (event: ReactPointerEvent<SVGElement>) => finishGesture(event, false),
  });

  const keyboardMove = (event: ReactKeyboardEvent<SVGElement>) => {
    if (!event.key.startsWith("Arrow") || editable.length === 0 || !origin) return;
    event.preventDefault();
    const amount = event.shiftKey ? 10 : 1;
    const start: [number, number] = [
      projected[0]?.bounds.origin[0] ?? composition.width / 2,
      projected[0]?.bounds.origin[1] ?? composition.height / 2,
    ];
    const current: [number, number] = [
      start[0] + (event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0),
      start[1] + (event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0),
    ];
    const delta = viewPlaneWorldDelta(start, current, [...origin], composition, camera);
    dispatch({ type: "operation", operations: operationsFor(editable, delta, new Map()) });
  };

  return (
    <svg
      aria-label={label}
      className="viewport-transform-controls viewport-transform-controls-3d"
      height={composition.height * zoom}
      ref={svgRef}
      viewBox={`0 0 ${composition.width * zoom} ${composition.height * zoom}`}
      width={composition.width * zoom}
    >
      {projected.map((member) => (
        <polygon
          className={`viewport-selection-outline viewport-selection-outline-3d ${member.layer.locked ? "locked" : ""}`}
          key={member.layer.id}
          points={pointsAttribute(member.bounds.outline, zoom)}
        />
      ))}
      {editable.length > 0
        ? projected
            .filter((member) => !member.layer.locked)
            .map((member) => (
              // biome-ignore lint/a11y/useSemanticElements: SVG geometry is the directly manipulated projected layer surface.
              <polygon
                {...interactionProps()}
                aria-label={label}
                className="viewport-selection-hit viewport-selection-hit-3d"
                key={`hit-${member.layer.id}`}
                onKeyDown={keyboardMove}
                points={pointsAttribute(member.bounds.outline, zoom)}
                role="button"
                tabIndex={0}
              />
            ))
        : null}
      {axes.map((axis) => (
        <g className={`viewport-gizmo-axis viewport-gizmo-axis-${axis.axis}`} key={axis.axis}>
          <line
            className="viewport-gizmo-axis-line"
            x1={axis.start[0] * zoom}
            x2={axis.end[0] * zoom}
            y1={axis.start[1] * zoom}
            y2={axis.end[1] * zoom}
          />
          {/* biome-ignore lint/a11y/useSemanticElements: The axis handle must remain in the SVG composition coordinate system. */}
          <circle
            {...interactionProps(axis)}
            aria-label={t("viewport.move3dAxis", {
              axis: axis.axis.toUpperCase(),
              space: t(`viewport.space.${space}`),
            })}
            className="viewport-gizmo-axis-handle"
            cx={axis.end[0] * zoom}
            cy={axis.end[1] * zoom}
            onKeyDown={keyboardMove}
            r={5}
            role="button"
            tabIndex={0}
          />
        </g>
      ))}
      {editable.length === 0 ? <title>{t("viewport.selectionLocked")}</title> : null}
    </svg>
  );
}

function buildControlMembers3d(
  composition: Composition,
  selection: readonly string[],
  time: number,
): ControlMember3d[] {
  const visible = new Set(visibleLayersAtTime(composition, time).map((layer) => layer.id));
  const selectionOrder = new Map(selection.map((id, index) => [id, index]));
  return composition.layers
    .filter(
      (layer) =>
        selectionOrder.has(layer.id) &&
        visible.has(layer.id) &&
        layer.threeDimensional &&
        layer.kind !== "audio" &&
        layer.kind !== "camera" &&
        layer.kind !== "light" &&
        layer.kind !== "adjustment",
    )
    .sort((left, right) => (selectionOrder.get(left.id) ?? 0) - (selectionOrder.get(right.id) ?? 0))
    .map((layer) => ({ layer, world: evaluateWorldTransform(layer, composition, time) }));
}

function topLevelEditableMembers3d(members: readonly ControlMember3d[]): ControlMember3d[] {
  const editableIds = new Set(
    members.filter((member) => !member.layer.locked).map(({ layer }) => layer.id),
  );
  const layers = new Map(members.map((member) => [member.layer.id, member.layer]));
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

function cancelPositionOperations(
  members: readonly ControlMember3d[],
  time: number,
  keyframeIds: ReadonlyMap<string, string>,
): Operation[] {
  return members.flatMap((member) =>
    POSITION_PATHS.flatMap((path): Operation[] => {
      const property = getProperty(member.layer, path);
      if (property.mode === "static")
        return [{ type: "setProperty", layerId: member.layer.id, path, value: property.value }];
      const current = property.keyframes.find(
        (keyframe) => Math.abs(keyframe.time - time) <= 0.000001,
      );
      if (current)
        return [{ type: "addKeyframe", layerId: member.layer.id, path, keyframe: current }];
      const id = keyframeIds.get(`${member.layer.id}:${path}`);
      return id ? [{ type: "removeKeyframe", layerId: member.layer.id, path, keyframeId: id }] : [];
    }),
  );
}

function averageWorldPosition(
  members: readonly ControlMember3d[],
): [number, number, number] | undefined {
  if (members.length === 0) return undefined;
  const sum = members.reduce(
    (result, member) => [
      result[0] + member.world.position[0],
      result[1] + member.world.position[1],
      result[2] + member.world.position[2],
    ],
    [0, 0, 0],
  );
  return [sum[0] / members.length, sum[1] / members.length, sum[2] / members.length];
}

function pointerInComposition(
  event: ReactPointerEvent<SVGElement>,
  svg: SVGSVGElement | null,
  zoom: number,
): [number, number] {
  const bounds = svg?.getBoundingClientRect();
  return bounds
    ? [(event.clientX - bounds.left) / zoom, (event.clientY - bounds.top) / zoom]
    : [event.clientX / zoom, event.clientY / zoom];
}

function pointsAttribute(points: readonly (readonly [number, number])[], zoom: number): string {
  return points.map((point) => `${point[0] * zoom},${point[1] * zoom}`).join(" ");
}

function vectorNearZero(vector: readonly number[]): boolean {
  return Math.hypot(...vector) < 0.000001;
}
