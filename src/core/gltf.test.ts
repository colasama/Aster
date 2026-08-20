import { describe, expect, it } from "vitest";
import { parseGltfAsset } from "./gltf";

describe("bounded glTF mesh import", () => {
  it("loads indexed triangle geometry from an embedded glTF buffer", () => {
    const binary = triangleBinary();
    const document = triangleDocument(
      `data:application/octet-stream;base64,${btoa(String.fromCharCode(...binary))}`,
    );
    const encoded = new TextEncoder().encode(JSON.stringify(document));
    const mesh = parseGltfAsset(
      encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
      "triangle.gltf",
    );

    expect(mesh.name).toBe("Triangle");
    expect(mesh.positions).toHaveLength(9);
    expect(mesh.indices).toEqual([0, 1, 2]);
    expect(mesh.normals).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(mesh.baseColor).toEqual([0.2, 0.4, 0.8, 0.35]);
    expect(mesh.sourceMaterial).toEqual({
      metallic: 0.7,
      roughness: 0.25,
      emissive: 0.3,
      alphaMode: "blend",
      alphaCutoff: 0.4,
    });
  });

  it("loads the same primitive from a GLB binary chunk", () => {
    const binary = triangleBinary();
    const json = new TextEncoder().encode(JSON.stringify(triangleDocument(undefined)));
    const jsonLength = Math.ceil(json.byteLength / 4) * 4;
    const binaryLength = Math.ceil(binary.byteLength / 4) * 4;
    const glb = new Uint8Array(12 + 8 + jsonLength + 8 + binaryLength);
    const view = new DataView(glb.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, glb.byteLength, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, 0x4e4f534a, true);
    glb.fill(0x20, 20, 20 + jsonLength);
    glb.set(json, 20);
    const binaryHeader = 20 + jsonLength;
    view.setUint32(binaryHeader, binaryLength, true);
    view.setUint32(binaryHeader + 4, 0x004e4942, true);
    glb.set(binary, binaryHeader + 8);

    expect(parseGltfAsset(glb.buffer, "triangle.glb").indices).toEqual([0, 1, 2]);
  });
});

function triangleBinary(): Uint8Array {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  positions.forEach((value, index) => {
    view.setFloat32(index * 4, value, true);
  });
  [0, 1, 2].forEach((value, index) => {
    view.setUint16(36 + index * 2, value, true);
  });
  return new Uint8Array(buffer);
}

function triangleDocument(uri: string | undefined) {
  return {
    asset: { version: "2.0" },
    buffers: [{ byteLength: 44, ...(uri ? { uri } : {}) }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.2, 0.4, 0.8, 0.35],
          metallicFactor: 0.7,
          roughnessFactor: 0.25,
        },
        emissiveFactor: [0.1, 0.3, 0.2],
        alphaMode: "BLEND",
        alphaCutoff: 0.4,
      },
    ],
    meshes: [
      { name: "Triangle", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
    ],
  };
}
