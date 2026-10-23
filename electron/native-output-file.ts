import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";

export interface NativeOutputFileIdentity {
  bytes: number;
  sha256: string;
  size?: { width: number; height: number };
}

/** Bounded file delivery; encoded output never becomes a whole-file JavaScript buffer. */
export async function admitNativeOutputFile(options: {
  source: string;
  destination?: string;
  bytes: number;
  sha256?: string;
  size?: { width: number; height: number };
  signal?: AbortSignal;
  isCancelled?: () => boolean;
}): Promise<NativeOutputFileIdentity> {
  const { source, destination, bytes, sha256, size, signal } = options;
  const active = () => {
    signal?.throwIfAborted();
    if (options.isCancelled?.()) throw new Error("Native output admission cancelled");
  };
  active();
  if (!Number.isSafeInteger(bytes) || bytes < 1 || (sha256 && !/^[a-f0-9]{64}$/.test(sha256)))
    throw new Error("Invalid native output file receipt");
  const original = await lstat(source);
  if (!original.isFile() || original.isSymbolicLink() || original.size !== bytes)
    throw new Error("Native output file type or size differs");
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output: Awaited<ReturnType<typeof open>> | undefined;
  let created = false,
    success = false;
  try {
    const before = await input.stat();
    if (
      !before.isFile() ||
      before.size !== bytes ||
      before.ino !== original.ino ||
      before.dev !== original.dev
    )
      throw new Error("Native output file changed before admission");
    if (destination) {
      output = await open(destination, "wx");
      created = true;
    }
    const hash = createHash("sha256");
    let count = 0;
    let header = Buffer.alloc(0);
    for await (const value of input.createReadStream({ autoClose: false, signal })) {
      active();
      const chunk = value as Buffer;
      count += chunk.length;
      if (count > bytes) throw new Error("Native output grew beyond its receipt");
      hash.update(chunk);
      if (header.length < 24)
        header = Buffer.concat([header, chunk.subarray(0, 24 - header.length)]);
      if (output) {
        let offset = 0;
        while (offset < chunk.length) {
          active();
          const written = await output.write(chunk, offset, chunk.length - offset);
          if (written.bytesWritten === 0) throw new Error("Native output copy made no progress");
          offset += written.bytesWritten;
        }
      }
    }
    const digest = hash.digest("hex"),
      after = await input.stat();
    if (
      count !== bytes ||
      after.size !== bytes ||
      after.mtimeMs !== before.mtimeMs ||
      (sha256 && digest !== sha256)
    )
      throw new Error("Native output bytes differ from their receipt");
    if (
      size &&
      (header.length !== 24 ||
        header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
        header.toString("ascii", 12, 16) !== "IHDR" ||
        header.readUInt32BE(16) !== size.width ||
        header.readUInt32BE(20) !== size.height)
    )
      throw new Error("Native PNG dimensions differ from its job");
    active();
    await output?.sync();
    success = true;
    return { bytes, sha256: digest, ...(size ? { size } : {}) };
  } finally {
    await Promise.all([input.close(), output?.close()]);
    if (!success && created && destination) await rm(destination, { force: true });
  }
}
