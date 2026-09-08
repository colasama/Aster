import { assertMatchingPathTopology } from "../../animation/path-morph";

import {
  MAX_AUDIO_LEVEL_DB,
  MAX_AUDIO_PAN,
  MIN_AUDIO_LEVEL_DB,
  MIN_AUDIO_PAN,
} from "../../audio/audio-layer";

import { assertAdjustmentLayerInvariants } from "../../layers/adjustment-layer";

import { validateShapeGraph } from "../../layers/shape-graph";

import { MAX_SOLID_DIMENSION } from "../../layers/solid-layer";

import { CAMERA_ANIMATABLE_FIELDS } from "../../scene/camera-properties";

import { validateClonerSettings } from "../../scene/cloner";

import { assertSceneGeneratorInstance } from "../../scene/scene-generator";

import { type Composition, type Effect, isLayerKind, type Layer } from "../../types";

import { validateEffect } from "./effects";

import { validateTextAnimator } from "./text";
import {
  requireFiniteNumber,
  requireNumberArray,
  requireObject,
  requirePositiveNumber,
  requireString,
  validateAnimatable,
  validateBezierPath,
  validateBoundedCameraProperty,
  validateBoundedNumber,
  validateTransform,
} from "./values";

export function validateLayer(
  value: unknown,
  composition: Composition,
  path: string,
): asserts value is Layer {
  const layer = requireObject(value, path);
  requireString(layer.id, `${path}.id`);
  requireString(layer.name, `${path}.name`);
  if (!isLayerKind(layer.kind)) throw new Error(`${path}.kind is unsupported`);
  if (typeof layer.motionBlur !== "boolean")
    throw new Error(`${path}.motionBlur must be a boolean`);
  if (layer.audioEnabled !== undefined && typeof layer.audioEnabled !== "boolean")
    throw new Error(`${path}.audioEnabled must be a boolean`);
  if (layer.audio !== undefined) {
    if (layer.kind !== "audio" && layer.kind !== "video")
      throw new Error(`${path}.audio requires an audio-capable layer`);
    const audio = requireObject(layer.audio, `${path}.audio`);
    const levelsDb = requireNumberArray(audio.levelsDb, `${path}.audio.levelsDb`, 2);
    if (
      levelsDb.length !== 2 ||
      levelsDb.some((level) => level < MIN_AUDIO_LEVEL_DB || level > MAX_AUDIO_LEVEL_DB)
    )
      throw new Error(
        `${path}.audio.levelsDb must contain left/right levels from ${MIN_AUDIO_LEVEL_DB} through ${MAX_AUDIO_LEVEL_DB} dB`,
      );
    const pan = requireFiniteNumber(audio.pan, `${path}.audio.pan`);
    if (pan < MIN_AUDIO_PAN || pan > MAX_AUDIO_PAN)
      throw new Error(`${path}.audio.pan must be between ${MIN_AUDIO_PAN} and ${MAX_AUDIO_PAN}`);
    for (const field of ["muted", "reversed"])
      if (typeof audio[field] !== "boolean")
        throw new Error(`${path}.audio.${field} must be a boolean`);
  }
  if ((layer.kind === "audio" || layer.kind === "video") && layer.audio === undefined)
    throw new Error(`${path}.audio is required for audio-capable layers`);
  if (
    layer.kind === "audio" &&
    (layer.visible !== false ||
      layer.threeDimensional !== false ||
      (Array.isArray(layer.size) && layer.size.some((value) => Number(value) !== 0)))
  )
    throw new Error(`${path} audio layers cannot have a visual surface`);
  if (layer.sourceId !== undefined) requireString(layer.sourceId, `${path}.sourceId`);
  if (layer.solid !== undefined) {
    if (layer.kind !== "solid") throw new Error(`${path}.solid requires solid layer kind`);
    const solid = requireObject(layer.solid, `${path}.solid`);
    for (const field of ["width", "height"] as const) {
      const dimension = requireFiniteNumber(solid[field], `${path}.solid.${field}`);
      if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > MAX_SOLID_DIMENSION)
        throw new Error(
          `${path}.solid.${field} must be an integer from 1 through ${MAX_SOLID_DIMENSION}`,
        );
    }
    const solidColor = requireNumberArray(solid.color, `${path}.solid.color`, 4);
    if (solidColor.length !== 4 || solidColor.some((channel) => channel < 0 || channel > 1))
      throw new Error(`${path}.solid.color must contain four channels from 0 through 1`);
    if (
      !Array.isArray(layer.size) ||
      layer.size[0] !== solid.width ||
      layer.size[1] !== solid.height
    )
      throw new Error(`${path}.size must mirror the dedicated solid dimensions`);
    if (
      !Array.isArray(layer.color) ||
      layer.color.length !== 4 ||
      layer.color.some((channel, index) => channel !== solidColor[index])
    )
      throw new Error(`${path}.color must mirror the dedicated solid color`);
  }
  if (layer.kind === "solid" && layer.solid === undefined)
    throw new Error(`${path}.solid is required for solid layers`);
  if (layer.text !== undefined && (typeof layer.text !== "string" || layer.text.length > 20_000))
    throw new Error(`${path}.text must be a string at most 20000 characters`);
  requirePositiveNumber(layer.outPoint, `${path}.outPoint`);
  if (layer.timeOffset !== undefined) {
    const offset = requireFiniteNumber(layer.timeOffset, `${path}.timeOffset`);
    if (offset < 0) throw new Error(`${path}.timeOffset must not be negative`);
  }
  if (layer.timeStretch !== undefined)
    requirePositiveNumber(layer.timeStretch, `${path}.timeStretch`);
  if (layer.timeRemap !== undefined) validateAnimatable(layer.timeRemap, `${path}.timeRemap`);
  validateTransform(layer.transform, `${path}.transform`);
  if (layer.material !== undefined) {
    const material = requireObject(layer.material, `${path}.material`);
    for (const field of ["metallic", "roughness", "emissive"])
      requireFiniteNumber(material[field], `${path}.material.${field}`);
    if (!["opaque", "mask", "blend"].includes(String(material.alphaMode)))
      throw new Error(`${path}.material.alphaMode is invalid`);
    const alphaCutoff = requireFiniteNumber(material.alphaCutoff, `${path}.material.alphaCutoff`);
    if (alphaCutoff < 0 || alphaCutoff > 1)
      throw new Error(`${path}.material.alphaCutoff must be between 0 and 1`);
  }
  if (layer.light !== undefined) {
    const light = requireObject(layer.light, `${path}.light`);
    if (!["directional", "point", "spot"].includes(String(light.kind)))
      throw new Error(`${path}.light.kind is invalid`);
    if (!["off", "low", "medium", "high"].includes(String(light.shadowQuality)))
      throw new Error(`${path}.light.shadowQuality is invalid`);
    const intensity = requireFiniteNumber(light.intensity, `${path}.light.intensity`);
    if (intensity < 0) throw new Error(`${path}.light.intensity must not be negative`);
    for (const field of ["range", "coneAngle"])
      requirePositiveNumber(light[field], `${path}.light.${field}`);
  }
  if (layer.camera !== undefined) {
    if (layer.kind !== "camera") throw new Error(`${path}.camera requires camera layer kind`);
    const camera = requireObject(layer.camera, `${path}.camera`);
    if (!["oneNode", "twoNode"].includes(String(camera.mode)))
      throw new Error(`${path}.camera.mode is invalid`);
    if (!["perspective", "orthographic"].includes(String(camera.projection)))
      throw new Error(`${path}.camera.projection is invalid`);
    if ("focalLength" in camera || "fStop" in camera)
      throw new Error(`${path}.camera must not persist derived focal length or f-stop`);
    for (const field of CAMERA_ANIMATABLE_FIELDS)
      validateBoundedCameraProperty(camera[field], `${path}.camera.${field}`, field);
    for (const field of ["pointOfInterest", "orientation"] as const) {
      if (!Array.isArray(camera[field]) || camera[field].length !== 3)
        throw new Error(`${path}.camera.${field} must contain three animated properties`);
      for (const [index, property] of camera[field].entries())
        validateAnimatable(property, `${path}.camera.${field}[${index}]`);
    }
    for (const field of ["depthOfField", "lockFocusToZoom"] as const)
      if (typeof camera[field] !== "boolean")
        throw new Error(`${path}.camera.${field} must be a boolean`);
    if (
      ![
        "fastRectangle",
        "square",
        "triangle",
        "pentagon",
        "hexagon",
        "heptagon",
        "octagon",
        "nonagon",
        "decagon",
        "circle",
      ].includes(String(camera.irisShape))
    )
      throw new Error(`${path}.camera.irisShape is invalid`);
    validateBoundedNumber(camera.renderQuality, `${path}.camera.renderQuality`, [1, 100]);
  }
  if (layer.kind === "camera" && layer.camera === undefined)
    throw new Error(`${path}.camera is required for camera layers`);
  if (layer.mesh !== undefined) {
    const mesh = requireObject(layer.mesh, `${path}.mesh`);
    requireString(mesh.name, `${path}.mesh.name`);
    const positions = requireNumberArray(mesh.positions, `${path}.mesh.positions`, 750_000);
    const normals = requireNumberArray(mesh.normals, `${path}.mesh.normals`, 750_000);
    const uvs = requireNumberArray(mesh.uvs, `${path}.mesh.uvs`, 500_000);
    const indices = requireNumberArray(mesh.indices, `${path}.mesh.indices`, 750_000);
    if (positions.length === 0 || positions.length % 3 !== 0)
      throw new Error(`${path}.mesh.positions must contain 3D vertices`);
    if (normals.length !== positions.length)
      throw new Error(`${path}.mesh.normals must match positions`);
    if (uvs.length !== (positions.length / 3) * 2)
      throw new Error(`${path}.mesh.uvs must match positions`);
    if (indices.length === 0 || indices.length % 3 !== 0)
      throw new Error(`${path}.mesh.indices must contain triangles`);
    if (
      indices.some(
        (index) => !Number.isInteger(index) || index < 0 || index >= positions.length / 3,
      )
    )
      throw new Error(`${path}.mesh.indices reference missing vertices`);
    if (mesh.sourceMaterial !== undefined) {
      const material = requireObject(mesh.sourceMaterial, `${path}.mesh.sourceMaterial`);
      for (const field of ["metallic", "roughness", "emissive", "alphaCutoff"])
        requireFiniteNumber(material[field], `${path}.mesh.sourceMaterial.${field}`);
      if (!["opaque", "mask", "blend"].includes(String(material.alphaMode)))
        throw new Error(`${path}.mesh.sourceMaterial.alphaMode is invalid`);
    }
    if (mesh.baseColor !== undefined) {
      requireNumberArray(mesh.baseColor, `${path}.mesh.baseColor`, 4);
      if ((mesh.baseColor as number[]).length !== 4)
        throw new Error(`${path}.mesh.baseColor must contain four channels`);
    }
    if (mesh.tangents !== undefined) {
      const tangents = requireNumberArray(mesh.tangents, `${path}.mesh.tangents`, 1_000_000);
      if (tangents.length !== (positions.length / 3) * 4)
        throw new Error(`${path}.mesh.tangents must contain xyzw values for every vertex`);
      for (let index = 0; index < tangents.length; index += 4) {
        if (Math.hypot(tangents[index], tangents[index + 1], tangents[index + 2]) < 1e-6)
          throw new Error(`${path}.mesh.tangents tangent xyz must not be near zero`);
        if (tangents[index + 3] !== -1 && tangents[index + 3] !== 1)
          throw new Error(`${path}.mesh.tangents handedness must be -1 or 1`);
      }
    }
    if (mesh.materialTextures !== undefined) {
      const textures = requireObject(mesh.materialTextures, `${path}.mesh.materialTextures`);
      for (const key of ["baseColor", "metallicRoughness", "normal", "emissive"])
        if (textures[key] !== undefined)
          validateMeshTexture(
            textures[key],
            `${path}.mesh.materialTextures.${key}`,
            key === "normal",
          );
    }
  }
  if (layer.generator !== undefined) {
    if (layer.kind !== "generator")
      throw new Error(`${path}.generator requires generator layer kind`);
    assertSceneGeneratorInstance(layer.generator, `${path}.generator`);
  }
  if (layer.kind === "generator" && layer.generator === undefined)
    throw new Error(`${path}.generator is required for generator layers`);
  if (layer.cloner !== undefined) validateClonerSettings(layer.cloner, `${path}.cloner`);
  if (layer.shape !== undefined) {
    const shape = requireObject(layer.shape, `${path}.shape`);
    if (
      shape.kind !== "rectangle" &&
      shape.kind !== "ellipse" &&
      shape.kind !== "line" &&
      shape.kind !== "bezier"
    )
      throw new Error(`${path}.shape.kind is invalid`);
    if (!["solid", "linear", "radial"].includes(String(shape.fillMode)))
      throw new Error(`${path}.shape.fillMode is invalid`);
    if (!["butt", "round"].includes(String(shape.lineCap)))
      throw new Error(`${path}.shape.lineCap is invalid`);
    if (
      shape.lineJoin !== undefined &&
      !["miter", "bevel", "round"].includes(String(shape.lineJoin))
    )
      throw new Error(`${path}.shape.lineJoin is invalid`);
    const roundness = requireFiniteNumber(shape.roundness, `${path}.shape.roundness`);
    const strokeWidth = requireFiniteNumber(shape.strokeWidth, `${path}.shape.strokeWidth`);
    const dashLength = requireFiniteNumber(shape.dashLength, `${path}.shape.dashLength`);
    const dashGap = requireFiniteNumber(shape.dashGap, `${path}.shape.dashGap`);
    requireFiniteNumber(shape.gradientAngle, `${path}.shape.gradientAngle`);
    if (shape.trim !== undefined) {
      const trim = requireObject(shape.trim, `${path}.shape.trim`);
      const start = requireFiniteNumber(trim.start, `${path}.shape.trim.start`);
      const end = requireFiniteNumber(trim.end, `${path}.shape.trim.end`);
      const offset = requireFiniteNumber(trim.offset, `${path}.shape.trim.offset`);
      if (start < 0 || start > 100 || end < 0 || end > 100)
        throw new Error(`${path}.shape.trim start and end must be percentages from 0 through 100`);
      if (Math.abs(offset) > 100_000)
        throw new Error(`${path}.shape.trim.offset exceeds the supported range`);
    }
    if (roundness < 0 || strokeWidth < 0 || dashLength < 0 || dashGap < 0)
      throw new Error(`${path}.shape dimensions must not be negative`);
    requireNumberArray(shape.strokeColor, `${path}.shape.strokeColor`, 4);
    if ((shape.strokeColor as number[]).length !== 4)
      throw new Error(`${path}.shape.strokeColor must contain four channels`);
    requireNumberArray(shape.gradientColor, `${path}.shape.gradientColor`, 4);
    if ((shape.gradientColor as number[]).length !== 4)
      throw new Error(`${path}.shape.gradientColor must contain four channels`);
    if (shape.kind === "bezier") validateBezierPath(shape.path, `${path}.shape.path`);
    if (shape.morph !== undefined) {
      if (shape.kind !== "bezier") throw new Error(`${path}.shape.morph requires a Bezier shape`);
      const morph = requireObject(shape.morph, `${path}.shape.morph`);
      validateBezierPath(morph.target, `${path}.shape.morph.target`);
      validateAnimatable(morph.progress, `${path}.shape.morph.progress`);
      assertMatchingPathTopology(
        shape.path as import("../../types").BezierPath,
        morph.target as import("../../types").BezierPath,
      );
    }
  }
  if (layer.shapeGraph !== undefined) validateShapeGraph(layer.shapeGraph, `${path}.shapeGraph`);
  if (layer.textStyle !== undefined) {
    const style = requireObject(layer.textStyle, `${path}.textStyle`);
    if (requireString(style.fontFamily, `${path}.textStyle.fontFamily`).length > 160)
      throw new Error(`${path}.textStyle.fontFamily is too long`);
    for (const field of ["fontSize", "fontWeight", "leading"])
      requirePositiveNumber(style[field], `${path}.textStyle.${field}`);
    for (const field of ["tracking", "strokeWidth"])
      requireFiniteNumber(style[field], `${path}.textStyle.${field}`);
    if ((style.strokeWidth as number) < 0)
      throw new Error(`${path}.textStyle.strokeWidth must not be negative`);
    const fontWeight = style.fontWeight as number;
    if (fontWeight < 100 || fontWeight > 900)
      throw new Error(`${path}.textStyle.fontWeight must be between 100 and 900`);
    if (!["left", "center", "right"].includes(String(style.alignment)))
      throw new Error(`${path}.textStyle.alignment is invalid`);
    const strokeColor = requireNumberArray(style.strokeColor, `${path}.textStyle.strokeColor`, 4);
    if (strokeColor.length !== 4)
      throw new Error(`${path}.textStyle.strokeColor must contain four channels`);
  }
  if (layer.textAnimator !== undefined)
    validateTextAnimator(layer.textAnimator, `${path}.textAnimator`);
  if (!Array.isArray(layer.size) || layer.size.length !== 2)
    throw new Error(`${path}.size must contain two values`);
  if (!Array.isArray(layer.color) || layer.color.length !== 4)
    throw new Error(`${path}.color must contain four channels`);
  requireObject(layer.transform, `${path}.transform`);
  if (!Array.isArray(layer.effects)) throw new Error(`${path}.effects must be an array`);
  for (const [index, effect] of layer.effects.entries())
    validateEffect(effect, `${path}.effects[${index}]`);
  const reusablePathIds = new Set(
    ((layer.shapeGraph as { paths?: Array<{ id?: unknown }> } | undefined)?.paths ?? []).map(
      (resource) => resource.id,
    ),
  );
  for (const [index, effect] of (layer.effects as Effect[]).entries()) {
    if (effect.mask?.shape !== "path") continue;
    if (!effect.mask.pathId || !reusablePathIds.has(effect.mask.pathId))
      throw new Error(`${path}.effects[${index}].mask references a missing shape path`);
  }
  assertAdjustmentLayerInvariants(layer as unknown as Layer, composition, path);
}

function validateMeshTexture(value: unknown, path: string, normal: boolean): void {
  const texture = requireObject(value, path);
  if (!["image/jpeg", "image/png", "image/webp"].includes(String(texture.mimeType)))
    throw new Error(`${path}.mimeType is invalid`);
  if (texture.texCoord !== 0) throw new Error(`${path}.texCoord must be 0`);
  const dataUrl = requireString(texture.dataUrl, `${path}.dataUrl`);
  if (dataUrl.length > 64 * 1024 * 1024)
    throw new Error(`${path}.dataUrl exceeds the 64 MiB encoded limit`);
  if (!/^data:image\/(?:jpeg|png|webp);base64,/i.test(dataUrl))
    throw new Error(`${path}.dataUrl must contain an embedded supported image`);
  if (texture.scale !== undefined) {
    if (!normal) throw new Error(`${path}.scale is only valid for a normal map`);
    const scale = requireFiniteNumber(texture.scale, `${path}.scale`);
    if (scale < -8 || scale > 8) throw new Error(`${path}.scale must be between -8 and 8`);
  }
}
