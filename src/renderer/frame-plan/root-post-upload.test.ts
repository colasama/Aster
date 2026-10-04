import { describe, expect, it, vi } from "vitest";
import { decodeFramePlan, encodeFramePlan } from "./codec";
import { rootPostPlanFixtures } from "./fixture";
import { buildRootPostUniformPlan } from "./root-post-plan";
import { uploadRootPostUniformPlan } from "./root-post-upload";
import { frameTimeFromNumber } from "./time";
import type { FramePlanSliceData } from "./types";

function fixture(time = 0.1) {
  const plan = buildRootPostUniformPlan({
    snapshot: { snapshotScope: "immutable-job:test", projectRevision: 42 },
    compositionId: "main",
    time,
    frameRate: { numerator: 24000, denominator: 1001 },
    target: { width: 16, height: 9 },
    renderTarget: { width: 32, height: 18 },
    antiAliasing: "ssaa2x",
  });
  const writes: Uint8Array[] = [];
  const writeBuffer = vi.fn(
    (_buffer, _offset, data: ArrayBuffer, offset: number, length: number) => {
      writes.push(new Uint8Array(data, offset, length).slice());
    },
  );
  const destination = {
    queue: { writeBuffer } as unknown as Pick<GPUQueue, "writeBuffer">,
    buffer: {} as GPUBuffer,
    target: { width: 16, height: 9 },
    renderTarget: { width: 32, height: 18 },
    antiAliasing: "ssaa2x" as const,
  };
  return { plan, destination, writeBuffer, writes };
}

function changeLane(plan: FramePlanSliceData, lane: number, value: number): void {
  const bytes = plan.blobs[0];
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat32(lane * 4, value, true);
}

describe("root post uniform byte executor", () => {
  it("uploads genuine long, NUL and unpaired UTF-16 identity fixtures without changing pixels", () => {
    for (const fixture of rootPostPlanFixtures().filter((value) =>
      value.id.endsWith("-identity"),
    )) {
      const plan = decodeFramePlan(fixture.bytes);
      const writeBuffer = vi.fn();
      uploadRootPostUniformPlan(plan, {
        queue: { writeBuffer },
        buffer: {} as GPUBuffer,
        target: { ...plan.metadata.header.target },
        renderTarget: { ...plan.metadata.header.render_target },
        antiAliasing: plan.metadata.header.aa,
      });
      const blob = plan.blobs[0];
      expect(writeBuffer).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        0,
        blob.buffer,
        blob.byteOffset,
        96,
      );
    }
  });

  it("consumes modified valid exposure bytes in both local and decoded plans", () => {
    for (const decoded of [false, true]) {
      const { plan, destination, writes, writeBuffer } = fixture();
      changeLane(plan, 3, 2.75);
      const supplied = decoded ? decodeFramePlan(encodeFramePlan(plan.metadata, plan.blobs)) : plan;
      uploadRootPostUniformPlan(supplied, destination);
      expect(writeBuffer).toHaveBeenCalledOnce();
      expect(writes).toEqual([plan.blobs[0]]);
      expect(new DataView(writes[0].buffer).getFloat32(12, true)).toBe(2.75);
    }
  });

  it("uploads only the selected borrowed view, excluding its container and sentinel bytes", () => {
    const { plan, destination, writes, writeBuffer } = fixture();
    const encoded = encodeFramePlan(plan.metadata, plan.blobs);
    const container = new Uint8Array(encoded.length + 48).fill(0xa5);
    container.set(encoded, 17);
    const decoded = decodeFramePlan(container.subarray(17, 17 + encoded.length));
    uploadRootPostUniformPlan(decoded, destination);
    expect(writes[0]).toEqual(plan.blobs[0]);
    expect(writes[0].byteLength).toBe(96);
    expect(writeBuffer).toHaveBeenCalledWith(
      destination.buffer,
      0,
      container.buffer,
      decoded.blobs[0].byteOffset,
      96,
    );
    expect([...container.subarray(0, 17)]).toEqual(Array(17).fill(0xa5));
    expect([...container.subarray(17 + encoded.length)]).toEqual(Array(31).fill(0xa5));
  });

  it("rejects unsupported scope and mismatched targets before any upload", () => {
    const corruptions: ((plan: FramePlanSliceData) => void)[] = [
      (plan) => {
        plan.metadata.resources.push("a".repeat(64));
      },
      (plan) => {
        plan.metadata.blobs.push({ ...plan.metadata.blobs[0], byte_offset: 96 });
        plan.metadata.slices.push({ kind: "post_process_uniforms", blob_index: 1 });
        plan.blobs = [...plan.blobs, plan.blobs[0].slice()];
      },
      (plan) => {
        plan.blobs = [...plan.blobs, plan.blobs[0].slice()];
      },
      (plan) => {
        plan.metadata.header.target.width += 1;
      },
      (plan) => {
        plan.metadata.header.render_target.height += 1;
      },
      (plan) => {
        plan.metadata.header.aa = "off";
      },
      (plan) => {
        plan.metadata.blobs[0].byte_length = 92;
      },
      (plan) => {
        plan.metadata.slices[0].blob_index = 1;
      },
      (plan) => {
        plan.blobs = [new Uint8Array(95)];
      },
      (plan) => {
        structuredClone(plan.blobs[0].buffer, { transfer: [plan.blobs[0].buffer] });
      },
      (plan) => {
        Object.assign(plan.metadata.header, { unexpected: true });
      },
      (plan) => {
        changeLane(plan, 23, -0);
      },
      (plan) => {
        changeLane(plan, 3, Infinity);
      },
      (plan) => {
        changeLane(plan, 2, NaN);
      },
      (plan) => {
        changeLane(plan, 2, 0.2);
      },
    ];
    for (const corrupt of corruptions) {
      const { plan, destination, writeBuffer } = fixture();
      corrupt(plan);
      expect(() => uploadRootPostUniformPlan(plan, destination)).toThrow();
      expect(writeBuffer).not.toHaveBeenCalled();
    }
  });

  it.each([16, 17, 18, 19])(
    "rejects unplanned root control lane %s while preserving the generic transport ABI",
    (lane) => {
      const { plan, destination, writeBuffer } = fixture();
      changeLane(plan, lane, 1);
      expect(() => encodeFramePlan(plan.metadata, plan.blobs)).not.toThrow();
      expect(() => uploadRootPostUniformPlan(plan, destination)).toThrow(/requires zero/);
      expect(writeBuffer).not.toHaveBeenCalled();
    },
  );

  it("binds all root time bits and permits only the header's signed f32 overflow", () => {
    for (const time of [-0, Number.MIN_VALUE, -1e-100, Number.MAX_VALUE, -Number.MAX_VALUE]) {
      const { plan, destination, writes } = fixture(time);
      uploadRootPostUniformPlan(plan, destination);
      expect(writes).toEqual([plan.blobs[0]]);
      changeLane(plan, 2, time < 0 || Object.is(time, -0) ? 0 : -0);
      if (time === Number.MIN_VALUE) changeLane(plan, 2, -0);
      expect(() => uploadRootPostUniformPlan(plan, destination)).toThrow(/time lane/);
    }
    const { plan, destination, writeBuffer } = fixture(0);
    plan.metadata.header.time = frameTimeFromNumber(-0);
    expect(() => uploadRootPostUniformPlan(plan, destination)).toThrow(/time lane/);
    expect(writeBuffer).not.toHaveBeenCalled();
  });
});
