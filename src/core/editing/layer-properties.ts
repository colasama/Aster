import { normalizeTextAnimatorSettings } from "../animation/text-animator";

import {
  collectTextAnimatorTrackEntries,
  getTextAnimatorProperty,
  isTextAnimatorPropertyPath,
  setTextAnimatorProperty,
} from "../animation/text-animator-property-paths";

import {
  CAMERA_ANIMATABLE_FIELDS,
  isCameraAnimatableField,
  normalizeCameraAnimatable,
} from "../scene/camera-properties";

import type { Animatable, Layer } from "../types";
import type { PropertyPath } from "./operation-types";

export function easeTransform(layer: Layer): void {
  const properties = [
    ...layer.transform.position,
    ...layer.transform.rotation,
    ...layer.transform.scale,
    ...layer.transform.anchor,
    layer.transform.opacity,
    ...(layer.camera
      ? [
          ...layer.camera.pointOfInterest,
          ...layer.camera.orientation,
          ...CAMERA_ANIMATABLE_FIELDS.map((field) => layer.camera?.[field]).filter(
            (property): property is Animatable => property !== undefined,
          ),
        ]
      : []),
  ];
  for (const property of properties) {
    if (property.mode !== "animated") continue;
    for (const keyframe of property.keyframes) {
      keyframe.interpolation = "bezier";
      keyframe.easing = [1 / 3, 0, 2 / 3, 1];
    }
  }
}

export function getProperty(layer: Layer, path: PropertyPath): Animatable {
  if (isTextAnimatorPropertyPath(path)) return getTextAnimatorProperty(layer, path);
  if (path === "shape.morphProgress") {
    if (!layer.shape?.morph) throw new Error("Path morph requires a configured target path");
    return layer.shape.morph.progress;
  }
  if (path === "opacity") return layer.transform.opacity;
  if (path.startsWith("camera.")) {
    if (!layer.camera) throw new Error("Camera property requires a camera layer");
    const cameraPath = path.slice("camera.".length);
    if (isCameraAnimatableField(cameraPath)) return layer.camera[cameraPath];
    const [, group, component] = path.split(".") as [
      "camera",
      "pointOfInterest" | "orientation",
      "0" | "1" | "2",
    ];
    return layer.camera[group][Number(component)];
  }
  const [group, component] = path.split(".") as [
    "position" | "rotation" | "scale" | "anchor",
    "0" | "1" | "2",
  ];
  return layer.transform[group][Number(component)];
}

export function setProperty(layer: Layer, path: PropertyPath, value: Animatable): void {
  if (isTextAnimatorPropertyPath(path)) {
    setTextAnimatorProperty(layer, path, value);
    if (layer.textAnimator) layer.textAnimator = normalizeTextAnimatorSettings(layer.textAnimator);
    return;
  }
  if (path === "shape.morphProgress") {
    if (!layer.shape?.morph) throw new Error("Path morph requires a configured target path");
    layer.shape.morph.progress = value;
    return;
  }
  if (path === "opacity") {
    layer.transform.opacity = value;
    return;
  }
  if (path.startsWith("camera.")) {
    if (!layer.camera) throw new Error("Camera property requires a camera layer");
    const cameraPath = path.slice("camera.".length);
    if (isCameraAnimatableField(cameraPath)) {
      layer.camera[cameraPath] = normalizeCameraAnimatable(value, cameraPath);
      if (cameraPath === "zoom" || cameraPath === "focusDistance")
        layer.camera.lockFocusToZoom = false;
      return;
    }
    const [, group, component] = path.split(".") as [
      "camera",
      "pointOfInterest" | "orientation",
      "0" | "1" | "2",
    ];
    layer.camera[group][Number(component)] = value;
    return;
  }
  const [group, component] = path.split(".") as [
    "position" | "rotation" | "scale" | "anchor",
    "0" | "1" | "2",
  ];
  layer.transform[group][Number(component)] = value;
}

/** Enumerates every operation-addressable numeric layer property in stable UI order. */
export function collectLayerPropertyPaths(layer: Layer): PropertyPath[] {
  const paths: PropertyPath[] = [
    "position.0",
    "position.1",
    "position.2",
    "rotation.0",
    "rotation.1",
    "rotation.2",
    "scale.0",
    "scale.1",
    "scale.2",
    ...(Array.isArray(layer.transform.anchor)
      ? (["anchor.0", "anchor.1", "anchor.2"] as const)
      : []),
    "opacity",
  ];
  if (layer.camera)
    paths.push(
      "camera.pointOfInterest.0",
      "camera.pointOfInterest.1",
      "camera.pointOfInterest.2",
      "camera.orientation.0",
      "camera.orientation.1",
      "camera.orientation.2",
      ...CAMERA_ANIMATABLE_FIELDS.map(
        (field) => `camera.${field}` as Extract<PropertyPath, `camera.${string}`>,
      ),
    );
  if (layer.shape?.morph) paths.push("shape.morphProgress");
  paths.push(...collectTextAnimatorTrackEntries(layer).map((entry) => entry.path));
  return paths;
}
