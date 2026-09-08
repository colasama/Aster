import { createId, type Keyframe, type Layer } from "../types";
import { getProperty, type Operation, type PropertyPath } from "./operations";

const KEYFRAME_TIME_EPSILON = 0.000_001;

/**
 * Builds the canonical operation for an interactive property value edit.
 * Static properties remain static; animated properties receive a keyframe at the edit time.
 */
export function propertyValueOperationAtTime(
  layer: Layer,
  path: PropertyPath,
  value: number,
  time: number,
  insertedKeyframeId?: string,
): Operation {
  if (!Number.isFinite(value)) throw new Error("Property value must be finite");
  if (!Number.isFinite(time)) throw new Error("Property edit time must be finite");
  const property = getProperty(layer, path);
  if (property.mode === "static") return { type: "setProperty", layerId: layer.id, path, value };

  const editTime = Math.max(0, time);
  const current = property.keyframes.find(
    (keyframe) => Math.abs(keyframe.time - editTime) <= KEYFRAME_TIME_EPSILON,
  );
  const keyframe: Keyframe = {
    id: current?.id ?? insertedKeyframeId ?? createId(),
    time: editTime,
    value,
    interpolation: current?.interpolation ?? "linear",
    ...(current?.easing ? { easing: current.easing } : {}),
    ...(current?.spatialIn !== undefined ? { spatialIn: current.spatialIn } : {}),
    ...(current?.spatialOut !== undefined ? { spatialOut: current.spatialOut } : {}),
  };
  return { type: "addKeyframe", layerId: layer.id, path, keyframe };
}
