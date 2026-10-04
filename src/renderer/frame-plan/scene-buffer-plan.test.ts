import { describe, expect, it, vi } from "vitest";
import { SCENE_LIGHTING_BYTES } from "../scene/scene-lighting";
import { decodeFramePlan, encodeFramePlan } from "./codec";
import { sceneBufferFixtureInput } from "./scene-buffer-fixture";
import { SCENE_LIGHTING_WIRE_BYTES } from "./scene-buffer-layout";
import { buildSceneBufferPlan } from "./scene-buffer-plan";
import { drawSceneShadows, prepareSceneBuffers, uploadSceneBuffers } from "./scene-buffer-upload";

describe("owned evaluated scene buffers", () => {
  it("preserves real nested-camera, mesh, vertex, lighting and motion bytes after producer mutation", () => {
    const input = sceneBufferFixtureInput();
    const originalVertices = new Uint8Array(input.geometry.data.buffer).slice();
    const originalLighting = new Uint8Array(input.lighting.buffer).slice();
    const originalMotion = input.motionVectors?.slice();
    const originalRanges = input.geometry.batches.map((batch) => [
      batch.vertexCount,
      1,
      batch.firstVertex,
    ]);
    const plan = buildSceneBufferPlan(input);
    expect(SCENE_LIGHTING_WIRE_BYTES).toBe(SCENE_LIGHTING_BYTES);
    expect(JSON.stringify(plan.metadata)).not.toContain('"layer"');
    input.geometry.data.fill(0);
    input.lighting.fill(0);
    input.motionVectors?.fill(0);
    for (const batch of input.geometry.batches) {
      batch.vertexCount = 0;
      batch.layer.threeDimensional = false;
    }
    const restored = decodeFramePlan(encodeFramePlan(plan.metadata, plan.blobs));
    const prepared = prepareSceneBuffers(structuredClone(restored));
    expect(prepared.vertices).toEqual(originalVertices);
    expect(prepared.lighting).toEqual(originalLighting);
    expect(prepared.motionVectors).toEqual(originalMotion);
    expect(prepared.draws.map((draw) => [draw.vertexCount, 1, draw.firstVertex])).toEqual(
      originalRanges,
    );
    expect(prepared.draws.some((draw) => draw.castsShadow)).toBe(true);
    expect(prepared.draws.some((draw) => !draw.castsShadow)).toBe(true);
  });

  it("uploads supplied unaligned bytes, obtains the resized destination and draws supplied shadow ranges", () => {
    const plan = buildSceneBufferPlan(sceneBufferFixtureInput());
    const backing = new Uint8Array(plan.blobs[0].length + 17);
    backing.set(plan.blobs[0], 17);
    const bytes = backing.subarray(17);
    new DataView(bytes.buffer, bytes.byteOffset).setFloat32(0, 7.25, true);
    new DataView(bytes.buffer, bytes.byteOffset).setFloat32(SCENE_LIGHTING_WIRE_BYTES, -0.75, true);
    const prepared = prepareSceneBuffers({
      metadata: structuredClone(plan.metadata),
      blobs: [bytes],
    });
    const events: string[] = [];
    const writes: Uint8Array[] = [];
    const lightingBuffer = {} as GPUBuffer;
    let shapeBuffer = {} as GPUBuffer;
    const resized = {} as GPUBuffer;
    uploadSceneBuffers(prepared, {
      lightingBuffer,
      get shapeBuffer() {
        return shapeBuffer;
      },
      ensureShapeBuffer: () => {
        events.push("resize");
        shapeBuffer = resized;
      },
      queue: {
        writeBuffer: (buffer, _offset, data, dataOffset, size) => {
          events.push(buffer === lightingBuffer ? "lighting" : "vertices");
          if (buffer !== lightingBuffer) expect(buffer).toBe(resized);
          writes.push(new Uint8Array(data as ArrayBuffer, dataOffset, size).slice());
        },
      },
    });
    expect(events).toEqual(["lighting", "resize", "vertices"]);
    expect(new DataView(writes[0].buffer).getFloat32(0, true)).toBe(7.25);
    expect(new DataView(writes[1].buffer).getFloat32(0, true)).toBe(-0.75);
    const draw = vi.fn();
    drawSceneShadows(prepared, { draw });
    expect(draw.mock.calls).toEqual(
      prepared.draws
        .filter((draw) => draw.castsShadow)
        .map((draw) => [draw.vertexCount, 1, draw.firstVertex]),
    );
    prepared.draws[0].castsShadow = true;
    prepared.draws[0].vertexCount = 1;
    prepared.draws[0].firstVertex = 2;
    draw.mockClear();
    drawSceneShadows(prepared, { draw });
    expect(draw.mock.calls[0]).toEqual([1, 1, 2]);
  });

  it("supports empty geometry without allocating a shape buffer", () => {
    const plan = buildSceneBufferPlan(sceneBufferFixtureInput(true));
    const prepared = prepareSceneBuffers(
      decodeFramePlan(encodeFramePlan(plan.metadata, plan.blobs)),
    );
    const ensureShapeBuffer = vi.fn();
    const writeBuffer = vi.fn();
    uploadSceneBuffers(prepared, {
      ensureShapeBuffer,
      queue: { writeBuffer },
      lightingBuffer: {} as GPUBuffer,
      shapeBuffer: {} as GPUBuffer,
    });
    expect(ensureShapeBuffer).not.toHaveBeenCalled();
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    expect(prepared.motionVectors?.length).toBe(0);
  });

  it("rejects mismatched buffers and out-of-range draws before any upload", () => {
    const plan = buildSceneBufferPlan(sceneBufferFixtureInput());
    expect(() => prepareSceneBuffers({ ...plan, blobs: [plan.blobs[0].subarray(4)] })).toThrow();
    const slice = plan.metadata.slices[0];
    if (slice.kind !== "scene_buffers") throw new Error("Expected scene slice");
    slice.draws[0].vertex_count = slice.vertex_count + 1;
    expect(() => prepareSceneBuffers(plan)).toThrow();
  });
});
