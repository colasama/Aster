import type { FlattenedSceneLayer } from "../core/scene-evaluation";
import type { SceneGeneratorDefinition } from "../core/scene-generator-registry";
import type { Composition, SceneGeneratorInstance } from "../core/types";
import type { SceneCamera } from "./geometry";
import { encodeRenderId } from "./render-buffers";

export const SCENE_GENERATOR_CONTEXT_BYTES = 160;
export const SCENE_GENERATOR_PARAMETER_VECTORS = 128;
export const SCENE_GENERATOR_PARAMETER_BYTES = SCENE_GENERATOR_PARAMETER_VECTORS * 16;

/** WGSL declarations shared by every scene-generator shader ABI v1 module. */
export const sceneGeneratorAbiWgsl = /* wgsl */ `
struct AsterGeneratorContext {
  resolution: vec2f,
  composition_time: f32,
  local_time: f32,
  frame_duration: f32,
  reserved_time: f32,
  instance_count: u32,
  instance_seed: u32,
  layer_position_opacity: vec4f,
  layer_rotation: vec4f,
  layer_scale: vec4f,
  camera_position: vec4f,
  camera_rotation: vec4f,
  camera_projection: vec4f,
  composition: vec4f,
  ids: vec4u,
}

struct AsterGeneratorParameters {
  values: array<vec4f, 128>,
}

struct AsterDrawIndirect {
  vertex_count: u32,
  instance_count: atomic<u32>,
  first_vertex: u32,
  first_instance: u32,
}
`;

export function buildSceneGeneratorContext(
  scene: FlattenedSceneLayer,
  composition: Composition,
  camera: SceneCamera | undefined,
  width: number,
  height: number,
  compositionTime: number,
  frameDuration: number,
  instanceCount: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(SCENE_GENERATOR_CONTEXT_BYTES);
  const floats = new Float32Array(buffer);
  const integers = new Uint32Array(buffer);
  floats.set([width, height, compositionTime, scene.localTime], 0);
  floats.set([frameDuration, 0], 4);
  integers[6] = instanceCount;
  integers[7] = encodeRenderId(scene.selectionId);
  floats.set([...scene.transform.position, scene.transform.opacity], 8);
  floats.set([...scene.transform.rotation, scene.layer.threeDimensional ? 1 : 0], 12);
  floats.set([...scene.transform.scale, 0], 16);
  const cameraPosition = camera?.transform.position ?? [
    composition.width / 2,
    composition.height / 2,
    0,
  ];
  const cameraRotation = camera?.transform.rotation ?? [0, 0, 0];
  const cameraSettings = camera?.settings ?? {
    projection: "perspective" as const,
    fieldOfView: 45,
    orthographicSize: composition.height,
  };
  const fovRadians = (cameraSettings.fieldOfView * Math.PI) / 180;
  const focalLength = composition.height / (2 * Math.tan(fovRadians / 2));
  floats.set([...cameraPosition, 0], 20);
  floats.set([...cameraRotation, 0], 24);
  floats.set(
    [
      cameraSettings.projection === "orthographic" ? 1 : 0,
      fovRadians,
      cameraSettings.orthographicSize,
      focalLength,
    ],
    28,
  );
  floats.set([composition.width, composition.height, width / Math.max(height, 1), 0], 32);
  integers.set(
    [encodeRenderId(scene.selectionId), encodeRenderId(`material:${scene.layer.kind}`), 0, 0],
    36,
  );
  return buffer;
}

export function buildSceneGeneratorParameters(
  definition: SceneGeneratorDefinition,
  instance: SceneGeneratorInstance,
): Float32Array {
  const output = new Float32Array(SCENE_GENERATOR_PARAMETER_VECTORS * 4);
  for (let index = 0; index < definition.parameters.length; index += 1) {
    const parameter = definition.parameters[index];
    const value = instance.parameters[parameter.name];
    const offset = index * 4;
    switch (parameter.type) {
      case "number": {
        const numeric =
          typeof value === "number" && Number.isFinite(value) ? value : parameter.default;
        output[offset] = Math.max(parameter.min, Math.min(parameter.max, numeric));
        break;
      }
      case "choice": {
        const choice =
          typeof value === "string" && parameter.choices.includes(value)
            ? value
            : parameter.default;
        output[offset] = parameter.choices.indexOf(choice);
        break;
      }
      case "color":
        output.set(boundedVector(value, parameter.default, 0, 1), offset);
        break;
      case "vector":
        output.set(boundedVector(value, parameter.default, parameter.min, parameter.max), offset);
        break;
      case "texture":
        break;
    }
  }
  return output;
}

function boundedVector(
  value: SceneGeneratorInstance["parameters"][string] | undefined,
  fallback: readonly number[],
  minimum: number,
  maximum: number,
): number[] {
  const source =
    Array.isArray(value) &&
    value.length === fallback.length &&
    value.every((channel) => Number.isFinite(channel))
      ? value
      : fallback;
  return source.map((channel) => Math.max(minimum, Math.min(maximum, channel)));
}

export function sceneGeneratorParameterIndex(
  definition: SceneGeneratorDefinition,
  name: string,
): number {
  return definition.parameters.findIndex((parameter) => parameter.name === name);
}
