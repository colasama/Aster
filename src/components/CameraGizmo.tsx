import type { Dispatch } from "react";
import type { EvaluatedTransform, Layer } from "../core/types";
import { useI18n } from "../i18n/react";
import type { EditorAction } from "../state/editor-store";

interface CameraGizmoProps {
  activeTool: "select" | "rotate";
  dispatch: Dispatch<EditorAction>;
  layer: Layer;
  transform: EvaluatedTransform;
  zoom: number;
}

export function CameraGizmo({ activeTool, dispatch, layer, transform, zoom }: CameraGizmoProps) {
  const { t } = useI18n();
  if (!layer.camera) return null;
  const geometry = cameraGizmoGeometry(layer.camera.projection, layer.camera.fieldOfView);
  const moveBy = (x: number, y: number) =>
    dispatch({
      type: "operation",
      operations: [
        { type: "setProperty", layerId: layer.id, path: "position.0", value: x },
        { type: "setProperty", layerId: layer.id, path: "position.1", value: y },
      ],
    });

  return (
    <button
      aria-label={t("viewport.camera.gizmo", { name: layer.name })}
      className={`camera-gizmo ${layer.locked ? "locked" : ""}`}
      onKeyDown={(event) => {
        if (layer.locked || !event.key.startsWith("Arrow")) return;
        event.preventDefault();
        const amount = event.shiftKey ? 10 : 1;
        moveBy(
          transform.position[0] +
            (event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0),
          transform.position[1] +
            (event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0),
        );
      }}
      onPointerDown={(event) => {
        if (layer.locked) return;
        event.preventDefault();
        event.stopPropagation();
        const element = event.currentTarget;
        const startX = event.clientX;
        const startY = event.clientY;
        const initialX = transform.position[0];
        const initialY = transform.position[1];
        const initialRotation = transform.rotation[2];
        const bounds = element.getBoundingClientRect();
        const centerX = bounds.left + 18;
        const centerY = bounds.top + 40;
        const startAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
        let nextX = initialX;
        let nextY = initialY;
        let nextRotation = initialRotation;
        const move = (moveEvent: PointerEvent) => {
          if (activeTool === "rotate") {
            const angle = Math.atan2(moveEvent.clientY - centerY, moveEvent.clientX - centerX);
            nextRotation = initialRotation + ((angle - startAngle) * 180) / Math.PI;
            element.style.setProperty("--camera-preview-rotation", `${nextRotation}deg`);
          } else {
            nextX = initialX + (moveEvent.clientX - startX) / zoom;
            nextY = initialY + (moveEvent.clientY - startY) / zoom;
            element.style.setProperty("--camera-drag-x", `${moveEvent.clientX - startX}px`);
            element.style.setProperty("--camera-drag-y", `${moveEvent.clientY - startY}px`);
          }
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          element.style.removeProperty("--camera-drag-x");
          element.style.removeProperty("--camera-drag-y");
          element.style.removeProperty("--camera-preview-rotation");
          if (activeTool === "rotate") {
            if (Math.abs(nextRotation - initialRotation) < 0.01) return;
            dispatch({
              type: "operation",
              operations: [
                {
                  type: "setProperty",
                  layerId: layer.id,
                  path: "rotation.2",
                  value: nextRotation,
                },
              ],
            });
          } else if (Math.hypot(nextX - initialX, nextY - initialY) >= 0.01) moveBy(nextX, nextY);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      style={{
        left: `${transform.position[0] * zoom}px`,
        top: `${transform.position[1] * zoom}px`,
        transform: `translate(calc(-18px + var(--camera-drag-x, 0px)), calc(-40px + var(--camera-drag-y, 0px))) rotate(var(--camera-preview-rotation, ${transform.rotation[2]}deg))`,
      }}
      title={
        layer.camera.projection === "perspective"
          ? t("viewport.camera.perspectiveHint", { degrees: layer.camera.fieldOfView })
          : t("viewport.camera.orthographicHint", { pixels: layer.camera.orthographicSize })
      }
      type="button"
    >
      <svg aria-hidden="true" viewBox="0 0 128 80">
        <path className="camera-frustum" d={geometry.path} />
        <path className="camera-body" d="M5 25h27v30H5zM32 32l15-9v34l-15-9z" />
        <circle className="camera-center" cx="18" cy="40" r="3" />
      </svg>
      <small>
        {layer.camera.projection === "orthographic" ? t("viewport.camera.ortho") : geometry.label}
      </small>
    </button>
  );
}

export function cameraGizmoGeometry(
  projection: "perspective" | "orthographic",
  fieldOfView: number,
): { path: string; label: string } {
  if (projection === "orthographic") return { path: "M47 24H118M47 56H118M118 24V56", label: "" };
  const safeFov = Math.max(1, Math.min(179, fieldOfView));
  const spread = Math.max(9, Math.min(35, Math.tan((safeFov * Math.PI) / 360) * 28));
  return {
    path: `M47 32L118 ${40 - spread}M47 48L118 ${40 + spread}M118 ${40 - spread}V${40 + spread}`,
    label: `${Math.round(safeFov)}°`,
  };
}
