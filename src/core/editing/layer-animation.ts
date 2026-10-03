import { collectTextAnimatorTrackEntries } from "../animation/text-animator-property-paths";
import type { Animatable, Keyframe, Layer } from "../types";
import { collectLayerPropertyPaths, getProperty } from "./layer-properties";

/** All owned animation, including tracks hidden by the timeline or by trimming. */
export function collectLayerAnimationKeyframes(layer: Layer): Keyframe[] {
  const textProperties = new Map<string, Animatable>(
    collectTextAnimatorTrackEntries(layer).map(({ path, property }) => [path, property]),
  );
  const properties = collectLayerPropertyPaths(layer).map(
    (path) => textProperties.get(path) ?? getProperty(layer, path),
  );
  if (layer.timeRemap) properties.push(layer.timeRemap);
  return [
    ...new Set([
      ...properties.flatMap((property) => (property.mode === "animated" ? property.keyframes : [])),
      ...layer.effects.flatMap((effect) => Object.values(effect.parameterKeyframes ?? {}).flat()),
    ]),
  ];
}

/** Mutates a transaction snapshot; validates the entire move before changing any track. */
export function moveLayerAnimation(layer: Layer, delta: number, duration: number): void {
  const keyframes = collectLayerAnimationKeyframes(layer);
  if (
    !Number.isFinite(delta) ||
    layer.inPoint + delta < -1e-7 ||
    layer.outPoint + delta > duration + 1e-7 ||
    keyframes.some(
      (keyframe) => !Number.isFinite(keyframe.time + delta) || keyframe.time + delta < -1e-7,
    )
  )
    throw new Error("Layer move exceeds the composition or animation time bounds");
  // Normalize only floating-point roundoff at zero, never clamp a real out-of-bounds move.
  layer.inPoint = Math.max(0, layer.inPoint + delta);
  layer.outPoint += delta;
  for (const keyframe of keyframes) keyframe.time = Math.max(0, keyframe.time + delta);
}
