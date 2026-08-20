import { createLayerForComposition } from "./layer-factory";
import type { Composition, Layer, MeshAsset } from "./types";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const MAX_VERTICES = 250_000;
const MAX_INDICES = 750_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

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
    }>;
  }>;
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
  if (uvs.length !== vertexCount * 2)
    throw new Error("glTF TEXCOORD_0 count does not match POSITION count");
  return {
    name: mesh.name?.trim() || name.replace(/\.(?:gltf|glb)$/i, "") || "Imported Mesh",
    positions,
    normals: normals.length > 0 ? normals : generateNormals(positions, indices),
    uvs,
    indices,
  };
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
  const accessor = document.accessors?.[accessorIndex];
  if (!accessor || accessor.bufferView === undefined)
    throw new Error("glTF accessor is missing data");
  if (accessor.type !== expectedType || !componentTypes.includes(accessor.componentType))
    throw new Error(`glTF ${expectedType} accessor has an unsupported component layout`);
  const bufferView = document.bufferViews?.[accessor.bufferView];
  const buffer = bufferView && buffers[bufferView.buffer];
  if (!bufferView || !buffer) throw new Error("glTF accessor references a missing buffer view");
  const components = expectedType === "VEC3" ? 3 : expectedType === "VEC2" ? 2 : 1;
  if (accessor.count <= 0 || accessor.count * components > maximumElements)
    throw new Error("glTF accessor exceeds the supported element count");
  const componentBytes =
    accessor.componentType === 5121 ? 1 : accessor.componentType === 5123 ? 2 : 4;
  const stride = bufferView.byteStride ?? components * componentBytes;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const required = start + Math.max(0, accessor.count - 1) * stride + components * componentBytes;
  if (required > buffer.byteLength) throw new Error("glTF accessor exceeds its buffer bounds");
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

function isGlb(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === GLB_MAGIC
  );
}
