import { createLayerForComposition } from "./layer-factory";
import type { Composition, Layer, MeshAsset, MeshMaterialTextures, MeshTexture } from "./types";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const MAX_VERTICES = 250_000;
const MAX_INDICES = 750_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

interface GltfTextureInfo {
  index: number;
  texCoord?: number;
  scale?: number;
}

interface GltfDocument {
  buffers?: Array<{ uri?: string; byteLength: number }>;
  bufferViews?: Array<{
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }>;
  accessors?: Array<{
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
  }>;
  meshes?: Array<{
    name?: string;
    primitives: Array<{
      attributes: Record<string, number>;
      indices?: number;
      mode?: number;
      material?: number;
    }>;
  }>;
  materials?: Array<{
    pbrMetallicRoughness?: {
      baseColorFactor?: number[];
      metallicFactor?: number;
      roughnessFactor?: number;
      baseColorTexture?: GltfTextureInfo;
      metallicRoughnessTexture?: GltfTextureInfo;
    };
    emissiveFactor?: number[];
    emissiveTexture?: GltfTextureInfo;
    normalTexture?: GltfTextureInfo;
    alphaMode?: string;
    alphaCutoff?: number;
  }>;
  textures?: Array<{ source?: number }>;
  images?: Array<{ uri?: string; bufferView?: number; mimeType?: string }>;
}

export async function createGltfLayerFromFile(
  file: File,
  composition: Composition,
  currentTime: number,
): Promise<Layer> {
  const mesh = parseGltfAsset(await file.arrayBuffer(), file.name);
  const layer = createLayerForComposition("mesh", composition, currentTime);
  layer.name = mesh.name;
  layer.mesh = mesh;
  if (mesh.sourceMaterial) layer.material = mesh.sourceMaterial;
  if (mesh.baseColor) layer.color = mesh.baseColor;
  return layer;
}

export function parseGltfAsset(source: ArrayBuffer, name: string): MeshAsset {
  if (source.byteLength === 0 || source.byteLength > MAX_FILE_BYTES)
    throw new Error("glTF assets must be between 1 byte and 64 MB");
  const bytes = new Uint8Array(source);
  const { document, binaryChunk } = isGlb(bytes)
    ? parseGlb(bytes)
    : { document: parseJson(bytes), binaryChunk: undefined };
  const mesh = document.meshes?.[0];
  const primitive = mesh?.primitives[0];
  if (!primitive) throw new Error("glTF does not contain a mesh primitive");
  if (primitive.mode !== undefined && primitive.mode !== 4)
    throw new Error("Only glTF triangle-list primitives are supported");
  const positionAccessor = primitive.attributes.POSITION;
  if (positionAccessor === undefined) throw new Error("glTF mesh is missing POSITION data");
  const buffers = loadBuffers(document, binaryChunk);
  const positions = readAccessor(
    document,
    buffers,
    positionAccessor,
    "VEC3",
    [5126],
    MAX_VERTICES * 3,
  );
  const vertexCount = positions.length / 3;
  if (vertexCount === 0 || vertexCount > MAX_VERTICES)
    throw new Error(`glTF vertex count must be between 1 and ${MAX_VERTICES}`);
  const normals =
    primitive.attributes.NORMAL === undefined
      ? []
      : readAccessor(
          document,
          buffers,
          primitive.attributes.NORMAL,
          "VEC3",
          [5126],
          MAX_VERTICES * 3,
        );
  const tangents =
    primitive.attributes.TANGENT === undefined
      ? []
      : readAccessor(
          document,
          buffers,
          primitive.attributes.TANGENT,
          "VEC4",
          [5126],
          MAX_VERTICES * 4,
        );
  const uvs =
    primitive.attributes.TEXCOORD_0 === undefined
      ? new Array(vertexCount * 2).fill(0)
      : readAccessor(
          document,
          buffers,
          primitive.attributes.TEXCOORD_0,
          "VEC2",
          [5126],
          MAX_VERTICES * 2,
        );
  const indices =
    primitive.indices === undefined
      ? Array.from({ length: vertexCount }, (_, index) => index)
      : readAccessor(
          document,
          buffers,
          primitive.indices,
          "SCALAR",
          [5121, 5123, 5125],
          MAX_INDICES,
        );
  if (indices.length === 0 || indices.length > MAX_INDICES || indices.length % 3 !== 0)
    throw new Error(`glTF index count must be a non-zero triangle list below ${MAX_INDICES}`);
  if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= vertexCount))
    throw new Error("glTF indices reference a vertex outside POSITION data");
  if (normals.length > 0 && normals.length !== positions.length)
    throw new Error("glTF NORMAL count does not match POSITION count");
  if (tangents.length > 0 && tangents.length !== vertexCount * 4)
    throw new Error("glTF TANGENT count does not match POSITION count");
  if (uvs.length !== vertexCount * 2)
    throw new Error("glTF TEXCOORD_0 count does not match POSITION count");
  const resolvedNormals = normals.length > 0 ? normals : generateNormals(positions, indices);
  const sourceMaterial = readMaterial(document, buffers, primitive.material);
  return {
    name: mesh.name?.trim() || name.replace(/\.(?:gltf|glb)$/i, "") || "Imported Mesh",
    positions,
    normals: resolvedNormals,
    tangents:
      tangents.length > 0
        ? normalizeTangents(tangents)
        : generateTangents(positions, resolvedNormals, uvs, indices),
    uvs,
    indices,
    sourceMaterial: sourceMaterial.material,
    baseColor: sourceMaterial.baseColor,
    materialTextures: sourceMaterial.textures,
  };
}

function readMaterial(
  document: GltfDocument,
  buffers: Uint8Array[],
  materialIndex: number | undefined,
): {
  material: MeshAsset["sourceMaterial"];
  baseColor: NonNullable<MeshAsset["baseColor"]>;
  textures?: MeshMaterialTextures;
} {
  const source = materialIndex === undefined ? undefined : document.materials?.[materialIndex];
  if (materialIndex !== undefined && !source)
    throw new Error("glTF primitive references a missing material");
  const pbr = source?.pbrMetallicRoughness;
  const baseColor = boundedVector(pbr?.baseColorFactor, 4, [1, 1, 1, 1]);
  const emissive = boundedVector(source?.emissiveFactor, 3, [0, 0, 0]);
  const alphaMode = (source?.alphaMode ?? "OPAQUE").toUpperCase();
  if (alphaMode !== "OPAQUE" && alphaMode !== "MASK" && alphaMode !== "BLEND")
    throw new Error(`glTF alpha mode ${alphaMode} is unsupported`);
  return {
    baseColor: baseColor as [number, number, number, number],
    material: {
      metallic: boundedScalar(pbr?.metallicFactor, 1),
      roughness: boundedScalar(pbr?.roughnessFactor, 1),
      emissive: Math.max(...emissive),
      alphaMode: alphaMode.toLowerCase() as "opaque" | "mask" | "blend",
      alphaCutoff: boundedScalar(source?.alphaCutoff, 0.5),
    },
    textures: compactTextures({
      baseColor: readTexture(document, buffers, pbr?.baseColorTexture),
      metallicRoughness: readTexture(document, buffers, pbr?.metallicRoughnessTexture),
      normal: readTexture(document, buffers, source?.normalTexture, true),
      emissive: readTexture(document, buffers, source?.emissiveTexture),
    }),
  };
}

function compactTextures(textures: MeshMaterialTextures): MeshMaterialTextures | undefined {
  return Object.values(textures).some(Boolean) ? textures : undefined;
}

function readTexture(
  document: GltfDocument,
  buffers: Uint8Array[],
  info: GltfTextureInfo | undefined,
  normal = false,
): MeshTexture | undefined {
  if (!info) return undefined;
  if (!Number.isSafeInteger(info.index) || info.index < 0)
    throw new Error("glTF material texture index is invalid");
  if ((info.texCoord ?? 0) !== 0)
    throw new Error("Only glTF TEXCOORD_0 material textures are supported");
  const texture = document.textures?.[info.index];
  const image = texture?.source === undefined ? undefined : document.images?.[texture.source];
  if (!texture || !image) throw new Error("glTF material texture references a missing image");
  const { bytes, mimeType } = readImage(document, buffers, image);
  const scale = normal ? boundedNormalScale(info.scale) : undefined;
  return {
    mimeType,
    dataUrl: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
    texCoord: 0,
    ...(scale === undefined ? {} : { scale }),
  };
}

function readImage(
  document: GltfDocument,
  buffers: Uint8Array[],
  image: NonNullable<GltfDocument["images"]>[number],
): { bytes: Uint8Array; mimeType: MeshTexture["mimeType"] } {
  if (image.uri !== undefined && image.bufferView !== undefined)
    throw new Error("glTF image must use either uri or bufferView, not both");
  if (image.uri !== undefined) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z\d+/=]+)$/i.exec(image.uri);
    if (!match) throw new Error("Only embedded PNG, JPEG, and WebP glTF images are supported");
    const mimeType = validatedImageMimeType(match[1]);
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0));
    } catch {
      throw new Error("glTF image data URI is invalid");
    }
    validateImageBytes(bytes);
    return { bytes, mimeType };
  }
  if (image.bufferView === undefined) throw new Error("glTF image is missing data");
  const mimeType = validatedImageMimeType(image.mimeType);
  const bufferView = document.bufferViews?.[image.bufferView];
  const buffer = bufferView && buffers[bufferView.buffer];
  if (!bufferView || !buffer) throw new Error("glTF image references a missing buffer view");
  const start = boundedInteger(bufferView.byteOffset ?? 0, "glTF image byte offset");
  const length = boundedInteger(bufferView.byteLength, "glTF image byte length");
  if (length === 0 || length > MAX_IMAGE_BYTES || start + length > buffer.byteLength)
    throw new Error("glTF image exceeds its buffer bounds");
  return { bytes: buffer.subarray(start, start + length), mimeType };
}

function validatedImageMimeType(value: string | undefined): MeshTexture["mimeType"] {
  const normalized = value?.toLowerCase();
  if (!IMAGE_MIME_TYPES.includes(normalized as (typeof IMAGE_MIME_TYPES)[number]))
    throw new Error("glTF image MIME type is unsupported");
  return normalized as MeshTexture["mimeType"];
}

function validateImageBytes(bytes: Uint8Array): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES)
    throw new Error("glTF image must be between 1 byte and 32 MB");
}

function boundedNormalScale(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) throw new Error("glTF normal texture scale is invalid");
  return Math.max(-8, Math.min(8, value));
}

function bytesToBase64(bytes: Uint8Array): string {
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    encoded += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(encoded);
}

function boundedVector(source: number[] | undefined, length: number, fallback: number[]): number[] {
  if (source === undefined) return fallback;
  if (source.length !== length || source.some((value) => !Number.isFinite(value)))
    throw new Error("glTF material factor is invalid");
  return source.map((value) => Math.max(0, Math.min(1, value)));
}

function boundedScalar(source: number | undefined, fallback: number): number {
  if (source === undefined) return fallback;
  if (!Number.isFinite(source)) throw new Error("glTF material factor is invalid");
  return Math.max(0, Math.min(1, source));
}

function parseGlb(bytes: Uint8Array): { document: GltfDocument; binaryChunk?: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2)
    throw new Error("Unsupported GLB header");
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== bytes.byteLength) throw new Error("GLB length is invalid");
  let offset = 12;
  let document: GltfDocument | undefined;
  let binaryChunk: Uint8Array | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    offset += 8;
    if (offset + length > bytes.byteLength) throw new Error("GLB chunk exceeds file bounds");
    const chunk = bytes.subarray(offset, offset + length);
    if (type === JSON_CHUNK) document = parseJson(chunk);
    else if (type === BIN_CHUNK) binaryChunk = chunk;
    offset += length;
  }
  if (!document) throw new Error("GLB is missing its JSON chunk");
  return { document, binaryChunk };
}

function parseJson(bytes: Uint8Array): GltfDocument {
  try {
    return JSON.parse(new TextDecoder().decode(bytes).replace(/\0+$/g, "").trim()) as GltfDocument;
  } catch {
    throw new Error("glTF JSON is invalid");
  }
}

function loadBuffers(document: GltfDocument, binaryChunk?: Uint8Array): Uint8Array[] {
  return (document.buffers ?? []).map((buffer, index) => {
    if (!buffer.uri) {
      if (index !== 0 || !binaryChunk) throw new Error("glTF references a missing binary buffer");
      return binaryChunk;
    }
    const match = /^data:[^,]*;base64,(.+)$/i.exec(buffer.uri);
    if (!match) throw new Error("External glTF buffers are not supported; embed them as data URIs");
    const decoded = Uint8Array.from(atob(match[1]), (character) => character.charCodeAt(0));
    if (decoded.byteLength < buffer.byteLength)
      throw new Error("glTF data URI buffer is truncated");
    return decoded;
  });
}

function readAccessor(
  document: GltfDocument,
  buffers: Uint8Array[],
  accessorIndex: number,
  expectedType: string,
  componentTypes: number[],
  maximumElements: number,
): number[] {
  if (!Number.isSafeInteger(accessorIndex) || accessorIndex < 0)
    throw new Error("glTF accessor index is invalid");
  const accessor = document.accessors?.[accessorIndex];
  if (!accessor || accessor.bufferView === undefined)
    throw new Error("glTF accessor is missing data");
  if (accessor.type !== expectedType || !componentTypes.includes(accessor.componentType))
    throw new Error(`glTF ${expectedType} accessor has an unsupported component layout`);
  const bufferView = document.bufferViews?.[accessor.bufferView];
  const buffer = bufferView && buffers[bufferView.buffer];
  if (!bufferView || !buffer) throw new Error("glTF accessor references a missing buffer view");
  const components =
    expectedType === "VEC4" ? 4 : expectedType === "VEC3" ? 3 : expectedType === "VEC2" ? 2 : 1;
  if (
    !Number.isSafeInteger(accessor.count) ||
    accessor.count <= 0 ||
    accessor.count * components > maximumElements
  )
    throw new Error("glTF accessor exceeds the supported element count");
  const componentBytes =
    accessor.componentType === 5121 ? 1 : accessor.componentType === 5123 ? 2 : 4;
  const elementBytes = components * componentBytes;
  const stride = bufferView.byteStride ?? elementBytes;
  if (!Number.isSafeInteger(stride) || stride < elementBytes || stride % componentBytes !== 0)
    throw new Error("glTF accessor byte stride is invalid");
  const viewStart = boundedInteger(bufferView.byteOffset ?? 0, "glTF buffer view byte offset");
  const viewLength = boundedInteger(bufferView.byteLength, "glTF buffer view byte length");
  const accessorOffset = boundedInteger(accessor.byteOffset ?? 0, "glTF accessor byte offset");
  const viewEnd = viewStart + viewLength;
  if (viewEnd > buffer.byteLength) throw new Error("glTF buffer view exceeds its buffer bounds");
  const start = viewStart + accessorOffset;
  const required = start + Math.max(0, accessor.count - 1) * stride + components * componentBytes;
  if (start < viewStart || required > viewEnd)
    throw new Error("glTF accessor exceeds its buffer view bounds");
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const values: number[] = [];
  for (let index = 0; index < accessor.count; index++) {
    for (let component = 0; component < components; component++) {
      const offset = start + index * stride + component * componentBytes;
      values.push(readComponent(view, offset, accessor.componentType));
    }
  }
  if (values.some((value) => !Number.isFinite(value)))
    throw new Error("glTF contains non-finite data");
  return values;
}

function boundedInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function readComponent(view: DataView, offset: number, componentType: number): number {
  if (componentType === 5121) return view.getUint8(offset);
  if (componentType === 5123) return view.getUint16(offset, true);
  if (componentType === 5125) return view.getUint32(offset, true);
  return view.getFloat32(offset, true);
}

function generateNormals(positions: number[], indices: number[]): number[] {
  const normals = new Array(positions.length).fill(0);
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index] * 3;
    const b = indices[index + 1] * 3;
    const c = indices[index + 2] * 3;
    const ab = [
      positions[b] - positions[a],
      positions[b + 1] - positions[a + 1],
      positions[b + 2] - positions[a + 2],
    ];
    const ac = [
      positions[c] - positions[a],
      positions[c + 1] - positions[a + 1],
      positions[c + 2] - positions[a + 2],
    ];
    const normal = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    for (const vertex of [a, b, c])
      for (let axis = 0; axis < 3; axis++) normals[vertex + axis] += normal[axis];
  }
  for (let index = 0; index < normals.length; index += 3) {
    const length = Math.hypot(normals[index], normals[index + 1], normals[index + 2]) || 1;
    normals[index] /= length;
    normals[index + 1] /= length;
    normals[index + 2] /= length;
  }
  return normals;
}

function normalizeTangents(source: number[]): number[] {
  const result = source.slice();
  for (let index = 0; index < result.length; index += 4) {
    const length = Math.hypot(result[index], result[index + 1], result[index + 2]);
    if (length < 0.000_001) throw new Error("glTF contains a zero-length tangent");
    result[index] /= length;
    result[index + 1] /= length;
    result[index + 2] /= length;
    result[index + 3] = result[index + 3] < 0 ? -1 : 1;
  }
  return result;
}

function generateTangents(
  positions: number[],
  normals: number[],
  uvs: number[],
  indices: number[],
): number[] {
  const vertexCount = positions.length / 3;
  const tangentAccum = new Array(vertexCount * 3).fill(0);
  const bitangentAccum = new Array(vertexCount * 3).fill(0);
  for (let index = 0; index < indices.length; index += 3) {
    const vertices = [indices[index], indices[index + 1], indices[index + 2]];
    const a = vertices[0] * 3;
    const b = vertices[1] * 3;
    const c = vertices[2] * 3;
    const uvA = vertices[0] * 2;
    const uvB = vertices[1] * 2;
    const uvC = vertices[2] * 2;
    const edge1 = [
      positions[b] - positions[a],
      positions[b + 1] - positions[a + 1],
      positions[b + 2] - positions[a + 2],
    ];
    const edge2 = [
      positions[c] - positions[a],
      positions[c + 1] - positions[a + 1],
      positions[c + 2] - positions[a + 2],
    ];
    const du1 = uvs[uvB] - uvs[uvA];
    const dv1 = uvs[uvB + 1] - uvs[uvA + 1];
    const du2 = uvs[uvC] - uvs[uvA];
    const dv2 = uvs[uvC + 1] - uvs[uvA + 1];
    const determinant = du1 * dv2 - dv1 * du2;
    if (Math.abs(determinant) < 0.000_000_1) continue;
    const reciprocal = 1 / determinant;
    const tangent = edge1.map((value, axis) => (value * dv2 - edge2[axis] * dv1) * reciprocal);
    const bitangent = edge1.map((value, axis) => (edge2[axis] * du1 - value * du2) * reciprocal);
    for (const vertex of vertices) {
      for (let axis = 0; axis < 3; axis++) {
        tangentAccum[vertex * 3 + axis] += tangent[axis];
        bitangentAccum[vertex * 3 + axis] += bitangent[axis];
      }
    }
  }
  const tangents: number[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * 3;
    const normal = normals.slice(offset, offset + 3);
    const accumulated = tangentAccum.slice(offset, offset + 3);
    const normalDotTangent = dot3(normal, accumulated);
    let tangent = accumulated.map((value, axis) => value - normal[axis] * normalDotTangent);
    let length = Math.hypot(...tangent);
    if (length < 0.000_001) {
      const axis = Math.abs(normal[2]) < 0.999 ? [0, 0, 1] : [0, 1, 0];
      tangent = cross3(axis, normal);
      length = Math.hypot(...tangent) || 1;
    }
    tangent = tangent.map((value) => value / length);
    const handedness =
      dot3(cross3(normal, tangent), bitangentAccum.slice(offset, offset + 3)) < 0 ? -1 : 1;
    tangents.push(tangent[0], tangent[1], tangent[2], handedness);
  }
  return tangents;
}

function dot3(left: number[], right: number[]): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross3(left: number[], right: number[]): number[] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function isGlb(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === GLB_MAGIC
  );
}
