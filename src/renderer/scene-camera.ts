import {
  activeCameraLayerAtTime,
  createDefaultCameraSettings,
  evaluateCameraSettings,
} from "../core/camera-settings";
import { evaluateWorldTransform } from "../core/scene-evaluation";
import type { Composition } from "../core/types";
import type { SceneCamera } from "./geometry";

export function evaluateSceneCamera(
  composition: Composition,
  time: number,
): SceneCamera | undefined {
  const layer = activeCameraLayerAtTime(composition, time);
  if (!layer) return undefined;
  const settings =
    layer.camera ?? createDefaultCameraSettings(composition.width, composition.height);
  const transform = evaluateWorldTransform(layer, composition, time);
  return {
    transform,
    settings,
    ...evaluateCameraSettings(settings, transform, time, composition.width),
  };
}
