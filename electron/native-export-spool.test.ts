// @vitest-environment node
import { appendFile, mkdtemp, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeFramePacket } from "../src/core/rendering/native-export-protocol";
import { canonicalNativeMetadata, ownNativeFrame } from "./native-export-input";
import { NativeExportSpool } from "./native-export-spool";

const roots: string[] = [];
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
async function create(count = 2, maxBytes = 4096) {
  const root = await mkdtemp(join(tmpdir(), "aster-spool-test-"));
  roots.push(root);
  return {
    root,
    spool: await NativeExportSpool.create(root, {
      frameCount: count,
      maxBytes,
      maxResources: 8,
      maxFrameBytes: 2048,
    }),
  };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("native export preflight spool", () => {
  it("admits all frames before replay, owns inputs and deduplicates stable resources", async () => {
    const { root, spool } = await create();
    try {
      const source = frame();
      const append = spool.append(0, source, async (owned) => {
        new Uint8Array(source.plan).fill(1);
        new Uint8Array(source.resources[0].bytes).fill(2);
        expect(owned.plan.every((b) => b === 7)).toBe(true);
      });
      await append;
      await expect(spool.read(0)).rejects.toThrow(/unavailable/);
      expect(() => spool.seal()).toThrow(/complete job/);
      const second = frame();
      second.resources[0].message.descriptor = {
        byte_length: 16,
        element_count: 16,
        element_type: "u8",
      };
      await spool.append(1, second, async () => {});
      spool.seal();
      const actual = await spool.read(0);
      expect(actual.plan.every((b) => b === 7)).toBe(true);
      expect(actual.resources[0].bytes.every((b) => b === 9)).toBe(true);
      expect(spool.statistics).toMatchObject({ frames: 2, resources: 1, sealed: true });
      await expect(spool.append(2, frame(), async () => {})).rejects.toThrow(/unavailable/);
    } finally {
      await spool.dispose();
    }
    expect(await readdir(root)).toEqual([]);
  });

  it("fails an entire job on resource mutation or failed admission", async () => {
    for (const failure of ["identity", "admission"]) {
      const { spool } = await create();
      try {
        await spool.append(0, frame(), async () => {});
        const next = frame();
        if (failure === "identity") new Uint8Array(next.resources[0].bytes).fill(3);
        await expect(
          spool.append(1, next, async () => {
            throw new Error("unsupported plan");
          }),
        ).rejects.toThrow();
        expect(() => spool.seal()).toThrow();
        await expect(spool.read(0)).rejects.toThrow();
      } finally {
        await spool.dispose();
      }
    }
  });

  it("enforces storage limits before invoking native admission", async () => {
    const { root, spool } = await create(1, 64);
    let admitted = false;
    await expect(
      spool.append(0, frame(), async () => {
        admitted = true;
      }),
    ).rejects.toThrow(/storage budget/);
    expect(admitted).toBe(false);
    await spool.dispose();
    expect(await readdir(root)).toEqual([]);
  });

  it("waits for a pending admission before disposing its unpublished files", async () => {
    const { root, spool } = await create(1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const append = spool.append(0, frame(), () => gate);
    const rejected = expect(append).rejects.toThrow(/cancelled/);
    await expect(spool.append(0, frame(), async () => {})).rejects.toThrow(/unavailable/);
    const disposed = spool.dispose();
    release();
    await Promise.all([rejected, disposed]);
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["0.json", "0.plan", "resources.pack"])(
    "rejects altered %s before replay",
    async (name) => {
      const { root, spool } = await create(1);
      try {
        await spool.append(0, frame(), async () => {});
        spool.seal();
        const [directory] = await readdir(root);
        const path = join(root, directory, name);
        await writeFile(path, Buffer.alloc((await stat(path)).size, 1));
        await expect(spool.read(0)).rejects.toThrow(/changed/);
        await expect(spool.read(0)).rejects.toThrow(/unavailable/);
      } finally {
        await spool.dispose();
      }
    },
  );

  it("replays shared and new packed resources in frame order across nonadjacent offsets", async () => {
    const { root, spool } = await create(3);
    try {
      const first = frame();
      const second = frame();
      second.resources[0].message.hash = "2".repeat(64);
      new Uint8Array(second.resources[0].bytes).fill(5);
      const third = frame();
      third.resources[0].message.hash = "3".repeat(64);
      new Uint8Array(third.resources[0].bytes).fill(4);
      third.resources.push(first.resources[0]);
      await spool.append(0, first, async () => {});
      await spool.append(1, second, async () => {});
      await spool.append(2, third, async () => {});
      spool.seal();
      const [directory] = await readdir(root);
      const files = await readdir(join(root, directory));
      expect(files.filter((name) => name.endsWith(".pack"))).toEqual(["resources.pack"]);
      expect(files.some((name) => name.endsWith(".resource"))).toBe(false);
      const actual = await spool.read(2);
      expect(actual.resources.map((resource) => resource.message.hash)).toEqual([
        "3".repeat(64),
        "1".repeat(64),
      ]);
      expect(actual.resources[0].bytes).toEqual(Buffer.alloc(16, 4));
      expect(actual.resources[1].bytes).toEqual(Buffer.alloc(16, 9));
      actual.resources[1].bytes.fill(0);
      expect((await spool.read(0)).resources[0].bytes).toEqual(Buffer.alloc(16, 9));
      expect(spool.statistics.resources).toBe(3);
    } finally {
      await spool.dispose();
    }
  });

  it.each(["growth", "truncation"])(
    "rejects packed resource %s and closes replay",
    async (mode) => {
      const { root, spool } = await create(1);
      try {
        await spool.append(0, frame(), async () => {});
        spool.seal();
        const [directory] = await readdir(root);
        const path = join(root, directory, "resources.pack");
        if (mode === "growth") await appendFile(path, "x");
        else await truncate(path, 1);
        await expect(spool.read(0)).rejects.toThrow(/size changed/);
        await expect(spool.read(0)).rejects.toThrow(/unavailable/);
      } finally {
        await spool.dispose();
      }
    },
  );

  it("bounds IPC aggregate bytes, duplicate hashes and nested metadata before copying", () => {
    expect(() => ownNativeFrame(frame(), 64)).toThrow(/byte limit/);
    const duplicate = frame();
    duplicate.resources.push(duplicate.resources[0]);
    expect(() => ownNativeFrame(duplicate)).toThrow(/duplicated/);
    expect(() => canonicalNativeMetadata(Array(4096).fill("x".repeat(60_000)))).toThrow(
      /byte limit/,
    );
    const nested: unknown[] = [];
    nested.push(nested);
    expect(() => canonicalNativeMetadata(nested)).toThrow(/nesting/);
  });
});
