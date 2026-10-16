// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { NativeFramePacket } from "../src/core/rendering/native-export-protocol";
import { NativeExportSpool } from "./native-export-spool";
import { NativeFrameAdmission } from "./native-frame-admission";

const limits = { frameCount: 2, maxBytes: 4096, maxResources: 8, maxFrameBytes: 2048 };
const frame = (): NativeFramePacket => ({
  plan: new Uint8Array(32).fill(7).buffer,
  resources: [
    {
      message: {
        type: "put_resource",
        hash: "1".repeat(64),
        kind: "buffer",
        descriptor: { element_type: "u8", element_count: 16, byte_length: 16 },
      },
      bytes: new Uint8Array(16).fill(9).buffer,
    },
  ],
});

it("matches raw spool input accounting while retaining only admitted identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-admission-test-"));
  const spool = await NativeExportSpool.create(root, limits);
  const admission = new NativeFrameAdmission(limits);
  try {
    for (let index = 0; index < limits.frameCount; index++) {
      const packet = frame();
      if (index)
        packet.resources[0].message.descriptor = {
          byte_length: 16,
          element_count: 16,
          element_type: "u8",
        };
      await spool.append(index, packet, async () => {});
      await admission.append(index, packet, async (owned) => {
        new Uint8Array(packet.plan).fill(0);
        new Uint8Array(packet.resources[0].bytes).fill(0);
        expect(owned.plan).toEqual(Buffer.alloc(32, 7));
        expect(owned.resources[0].bytes).toEqual(Buffer.alloc(16, 9));
      });
      expect(admission.statistics).toEqual(spool.statistics);
    }
    admission.seal();
    spool.seal();
    expect(admission.statistics).toEqual(spool.statistics);
    await expect(admission.append(2, frame(), async () => {})).rejects.toThrow(/unavailable/);
  } finally {
    await Promise.all([admission.dispose(), spool.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["pixels", "metadata", "native"])("invalidates the job on changed %s", async (failure) => {
  const admission = new NativeFrameAdmission(limits);
  await admission.append(0, frame(), async () => {});
  const packet = frame();
  if (failure === "pixels") new Uint8Array(packet.resources[0].bytes).fill(0);
  if (failure === "metadata") packet.resources[0].message.descriptor.byte_length = 15;
  const accept = vi.fn(async () => {
    throw Error("native validation failed");
  });
  await expect(admission.append(1, packet, accept)).rejects.toThrow(
    failure === "native" ? /native validation/ : /identity changed/,
  );
  if (failure !== "native") expect(accept).not.toHaveBeenCalled();
  expect(admission.statistics.frames).toBe(1);
  expect(() => admission.seal()).toThrow(/complete job/);
  await expect(admission.append(1, frame(), async () => {})).rejects.toThrow(/unavailable/);
  await admission.dispose();
});

it("checks byte, resource and frame limits before native side effects", async () => {
  for (const constraints of [
    { ...limits, maxBytes: 64 },
    { ...limits, maxFrameBytes: 64 },
    { ...limits, maxResources: 1 },
  ]) {
    const admission = new NativeFrameAdmission(constraints);
    const packet = frame();
    const second = frame().resources[0];
    second.message.hash = "2".repeat(64);
    packet.resources.push(second);
    const accept = vi.fn(async () => {});
    await expect(admission.append(0, packet, accept)).rejects.toThrow(/budget|byte limit/);
    expect(accept).not.toHaveBeenCalled();
    expect(admission.statistics.frames).toBe(0);
    await admission.dispose();
  }
  expect(() => new NativeFrameAdmission({ ...limits, maxResources: 262145 })).toThrow(/limits/);
  const admission = new NativeFrameAdmission(limits);
  await expect(admission.append(1, frame(), async () => {})).rejects.toThrow(/out of order/);
  expect(() => admission.seal()).toThrow(/complete job/);
  await admission.dispose();
});

it("drains pending admission and never records a frame after cancellation", async () => {
  const admission = new NativeFrameAdmission(limits);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = admission.append(0, frame(), () => gate);
  const rejected = expect(pending).rejects.toThrow(/cancelled/);
  await expect(admission.append(0, frame(), async () => {})).rejects.toThrow(/unavailable/);
  expect(() => admission.seal()).toThrow(/complete job/);
  let done = false;
  const disposed = admission.dispose().then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  release();
  await Promise.all([rejected, disposed]);
  expect(admission.statistics).toEqual({ frames: 0, resources: 0, bytes: 0, sealed: false });
  await expect(admission.append(0, frame(), async () => {})).rejects.toThrow(/unavailable/);
});

it("reuses authenticated metadata without retaining or retransmitting payload bytes", async () => {
  const full = new NativeFrameAdmission(limits);
  const delta = new NativeFrameAdmission(limits);
  try {
    await full.append(0, frame(), async () => {});
    await delta.append(0, frame(), async () => {});
    await full.append(1, frame(), async () => {});
    const packet = frame();
    await delta.append(
      1,
      {
        plan: packet.plan,
        resources: [],
        retainedResources: [packet.resources[0].message.hash],
      },
      async (owned) => {
        expect(owned.resources).toHaveLength(1);
        expect(owned.resources[0].message).toEqual(packet.resources[0].message);
        expect(owned.resources[0].bytes.length).toBe(0);
        expect(owned.resources[0].retainedBytes).toBe(16);
      },
    );
    expect(delta.statistics).toEqual(full.statistics);
  } finally {
    await Promise.all([full.dispose(), delta.dispose()]);
  }
});

it("keeps retained snapshots private across consumer mutation and successive references", async () => {
  const admission = new NativeFrameAdmission({
    ...limits,
    frameCount: 3,
    maxBytes: 1_000_000,
    maxFrameBytes: 100_000,
  });
  const message = {
    type: "put_resource" as const,
    hash: "1".repeat(64),
    kind: "media_source" as const,
    descriptor: {
      source_id: { utf16_units: [97, 0xd800] },
      content_identity: "immutable identity".repeat(1000),
      media_kind: "image" as const,
      authorization_scope: "job",
    },
  };
  try {
    for (let index = 0; index < 3; index++) {
      await admission.append(
        index,
        {
          plan: new ArrayBuffer(32),
          resources: index ? [] : [{ message, bytes: new ArrayBuffer(0) }],
          ...(index ? { retainedResources: [message.hash] } : {}),
        },
        async (owned) => {
          const resource = owned.resources[0];
          expect(resource.message).toEqual(message);
          expect(JSON.parse(resource.control.toString("utf8"))).toEqual(message);
          if (
            resource.message.kind !== "media_source" ||
            typeof resource.message.descriptor.source_id === "string"
          )
            throw Error("Expected UTF-16 media source");
          resource.message.descriptor.source_id.utf16_units[0] = 98;
          resource.message.descriptor.content_identity = "consumer changed";
          resource.control.fill(0);
        },
      );
    }
    admission.seal();
    expect(admission.statistics).toMatchObject({ frames: 3, resources: 1, sealed: true });
  } finally {
    await admission.dispose();
  }
});

it("rejects cold, duplicate, expired and logically oversized resource references", async () => {
  const key = frame().resources[0].message.hash;
  const reference = (): NativeFramePacket => ({
    plan: new ArrayBuffer(32),
    resources: [],
    retainedResources: [key],
  });
  const cold = new NativeFrameAdmission(limits);
  const accept = vi.fn(async () => {});
  await expect(cold.append(0, reference(), accept)).rejects.toThrow(/accepted frame window/);
  expect(accept).not.toHaveBeenCalled();
  await cold.dispose();
  for (const mode of ["duplicate", "full-duplicate", "expired", "logical-budget"] as const) {
    const admission = new NativeFrameAdmission({ ...limits, frameCount: 3, maxFrameBytes: 384 });
    await admission.append(0, frame(), async () => {});
    const packet = reference();
    let index = 1;
    if (mode === "duplicate") packet.retainedResources?.push(key);
    if (mode === "full-duplicate") packet.resources = frame().resources;
    if (mode === "logical-budget") packet.plan = new ArrayBuffer(320);
    if (mode === "expired") {
      await admission.append(1, { plan: new ArrayBuffer(32), resources: [] }, async () => {});
      index = 2;
    }
    const rejected = vi.fn(async () => {});
    await expect(admission.append(index, packet, rejected)).rejects.toThrow(
      /duplicated|accepted frame window|logical frame byte limit/,
    );
    expect(rejected).not.toHaveBeenCalled();
    await admission.dispose();
  }
});

it.each([0, 1, 8])("preserves the raw spool byte boundary for %s resources", async (count) => {
  const root = await mkdtemp(join(tmpdir(), "aster-admission-budget-test-"));
  const constraints = { ...limits, frameCount: 1, maxFrameBytes: 4096 };
  const packet = frame();
  packet.resources = Array.from({ length: count }, (_, index) => {
    const resource = frame().resources[0];
    resource.message.hash = (index + 1).toString(16).padStart(64, "0");
    return resource;
  });
  const spool = await NativeExportSpool.create(root, constraints);
  try {
    await spool.append(0, packet, async () => {});
    const required = spool.statistics.bytes;
    for (const maximum of [required - 1, required]) {
      const admission = new NativeFrameAdmission({ ...constraints, maxBytes: maximum });
      const accept = vi.fn(async () => {});
      try {
        if (maximum < required) {
          await expect(admission.append(0, packet, accept)).rejects.toThrow(/input budget/);
          expect(accept).not.toHaveBeenCalled();
        } else {
          await admission.append(0, packet, accept);
          expect(admission.statistics).toEqual(spool.statistics);
          expect(accept).toHaveBeenCalledOnce();
        }
      } finally {
        await admission.dispose();
      }
    }
  } finally {
    await spool.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
