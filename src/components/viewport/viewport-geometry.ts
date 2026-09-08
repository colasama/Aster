import type { activeComposition } from "../../core/project/project";
import { createDefaultEvaluatedCamera } from "../../core/scene/camera-settings";

import type { Project } from "../../core/types";

import { evaluateSceneCamera } from "../../renderer/scene/scene-camera";

import { hitTestSceneLayerAtPoint } from "../../viewport/transform-3d-interaction";

export function hitTestLayer(
  composition: ReturnType<typeof activeComposition>,
  project: Project,
  time: number,
  x: number,
  y: number,
) {
  const camera =
    evaluateSceneCamera(composition, time) ??
    createDefaultEvaluatedCamera(composition.width, composition.height);
  return hitTestSceneLayerAtPoint(composition, project, time, [x, y], camera);
}

export function rotateViewportPoint(x: number, y: number, degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  return [
    x * Math.cos(radians) - y * Math.sin(radians),
    x * Math.sin(radians) + y * Math.cos(radians),
  ];
}

export function safeScaleRatio(value: number, origin: number): number {
  return Math.abs(origin) < 0.5 ? 1 : value / origin;
}

export function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 100;
  const sign = value < 0 ? -1 : 1;
  return sign * Math.max(0.1, Math.min(10_000, Math.abs(value)));
}

export function viewportCssMatrix(
  transform: {
    position: readonly number[];
    rotation: readonly number[];
    scale: readonly number[];
    anchor: readonly number[];
  },
  zoom: number,
): string {
  const radians = (transform.rotation[2] * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const scaleX = transform.scale[0] / 100;
  const scaleY = transform.scale[1] / 100;
  const a = cosine * scaleX;
  const b = sine * scaleX;
  const c = -sine * scaleY;
  const d = cosine * scaleY;
  const e = (transform.position[0] - a * transform.anchor[0] - c * transform.anchor[1]) * zoom;
  const f = (transform.position[1] - b * transform.anchor[0] - d * transform.anchor[1]) * zoom;
  return `matrix(${a}, ${b}, ${c}, ${d}, ${e}, ${f})`;
}
