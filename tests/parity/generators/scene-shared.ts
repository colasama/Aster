import {
  type Animatable,
  createId,
  createTransform,
  type Layer,
  setLayerSizeAndCenterAnchor,
} from "../../../src/core/types";
import type { fixture } from "./base";

export function motion(from: number, to: number): Animatable {
  return {
    mode: "animated",
    keyframes: [
      { id: createId(), time: 0, value: from, interpolation: "linear" },
      { id: createId(), time: 2, value: to, interpolation: "linear" },
    ],
  };
}

export function rectangle(
  scene: ReturnType<typeof fixture>,
  name: string,
  position: [number, number, number],
  size: [number, number],
  color: Layer["color"],
): Layer {
  const layer = scene.layer("shape", name);
  setLayerSizeAndCenterAnchor(layer, size);
  layer.transform = createTransform(position, [size[0] / 2, size[1] / 2, 0]);
  layer.color = color;
  return layer;
}
