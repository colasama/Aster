import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { admitNativeOutputFile } from "./native-output-file.js";

test("native output copies authenticate bytes and extent without overwriting existing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-native-output-"));
  try {
    const bytes = Buffer.alloc(128);
    bytes.set(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    bytes.writeUInt32BE(2, 16);
    bytes.writeUInt32BE(1, 20);
    const source = join(root, "source.png"),
      destination = join(root, "copy.png");
    await writeFile(source, bytes);
    const options = {
      source,
      destination,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: { width: 2, height: 1 },
    };
    const identity = await admitNativeOutputFile(options);
    expect(await readFile(destination)).toEqual(bytes);
    await expect(admitNativeOutputFile(options)).rejects.toThrow();
    expect(await readFile(destination)).toEqual(bytes);
    for (const change of [
      { bytes: 129 },
      { sha256: "0".repeat(64) },
      { size: { width: 3, height: 1 } },
    ]) {
      const rejected = join(root, "rejected.png");
      await expect(
        admitNativeOutputFile({ ...options, ...change, destination: rejected }),
      ).rejects.toThrow();
      expect(await readdir(root)).not.toContain("rejected.png");
    }
    await writeFile(destination, Buffer.alloc(128));
    await expect(admitNativeOutputFile({ source: destination, ...identity })).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation during streamed admission removes only its incomplete copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-native-output-cancel-"));
  try {
    const source = join(root, "source.mp4"),
      destination = join(root, "cancelled.mp4");
    await writeFile(source, Buffer.alloc(4 * 1024 * 1024, 7));
    let checks = 0;
    await expect(
      admitNativeOutputFile({
        source,
        destination,
        bytes: 4 * 1024 * 1024,
        isCancelled: () => ++checks > 4,
      }),
    ).rejects.toThrow("cancelled");
    expect(await readdir(root)).toEqual(["source.mp4"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
