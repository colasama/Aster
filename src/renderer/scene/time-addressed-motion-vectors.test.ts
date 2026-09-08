import { describe, expect, it, vi } from "vitest";
import type { GeometryResult } from "../geometry/geometry";
import { FLOATS_PER_VERTEX } from "../geometry/geometry";
import {
  buildTimeAddressedMotionVectors,
  GpuTimeAddressedMotionVectors,
  motionVectorBufferBytes,
} from "./time-addressed-motion-vectors";

describe("time-addressed motion vectors", () => {
  it("uses shutter endpoints and the stable instance identity", () => {
    const current = geometry("root/layer", 0, 0);
    const open = geometry("root/layer", -0.25, -0.5);
    const close = geometry("root/layer", 0.75, 0.5);
    expect(buildTimeAddressedMotionVectors(current, open, close, new Set(["layer"]))).toEqual(
      new Float32Array([0.5, -0.5]),
    );
  });

  it("zeros disabled layers and topology changes instead of reusing history", () => {
    const current = geometry("root/layer", 0, 0);
    const moved = geometry("root/layer", 1, 1);
    expect(buildTimeAddressedMotionVectors(current, current, moved, new Set())).toEqual(
      new Float32Array([0, 0]),
    );
    moved.batches[0].vertexCount = 2;
    expect(buildTimeAddressedMotionVectors(current, current, moved, new Set(["layer"]))).toEqual(
      new Float32Array([0, 0]),
    );
  });

  it("keeps GPU allocation bounded and power-of-two", () => {
    expect(motionVectorBufferBytes(0)).toBe(8);
    expect(motionVectorBufferBytes(3)).toBe(32);
    expect(() => motionVectorBufferBytes(-1)).toThrow("non-negative");
  });

  it("clears a reused GPU buffer without allocating CPU zero vectors", () => {
    const previousUsage = (globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage;
    (globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage = { VERTEX: 1, COPY_DST: 2 };
    const buffer = { destroy: vi.fn() } as unknown as GPUBuffer;
    const device = {
      createBuffer: vi.fn(() => buffer),
      queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    const encoder = { clearBuffer: vi.fn() } as unknown as GPUCommandEncoder;
    try {
      const vectors = new GpuTimeAddressedMotionVectors(device);
      expect(vectors.clear(3, encoder)).toBe(buffer);
      expect(vectors.clear(1, encoder)).toBe(buffer);
      expect(device.createBuffer).toHaveBeenCalledOnce();
      expect(device.createBuffer).toHaveBeenCalledWith(
        expect.objectContaining({ size: 32, usage: 3 }),
      );
      expect(encoder.clearBuffer).toHaveBeenCalledTimes(2);
      expect(device.queue.writeBuffer).not.toHaveBeenCalled();
      vectors.destroy();
      expect(buffer.destroy).toHaveBeenCalledOnce();
    } finally {
      (globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage = previousUsage;
    }
  });
});

function geometry(instanceId: string, x: number, y: number): GeometryResult {
  const data = new Float32Array(FLOATS_PER_VERTEX);
  data[0] = x;
  data[1] = y;
  return {
    data,
    batches: [
      {
        layer: { id: "layer" } as GeometryResult["batches"][number]["layer"],
        instanceId,
        resourceInstanceId: instanceId,
        selectionId: "layer",
        firstVertex: 0,
        vertexCount: 1,
      },
    ],
  };
}
