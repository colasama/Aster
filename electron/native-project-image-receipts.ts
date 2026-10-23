import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import {
  type NativeProjectExportExpectation,
  type NativeProjectExportReceipt,
  type NativeProjectImageReceipt,
  parseNativeProjectImage,
} from "./native-project-export-protocol.js";

/** Callers stage yielded files privately; only full iteration authenticates the complete journal. */
export async function* readNativeProjectImages(
  receipt: NativeProjectExportReceipt,
  expected: NativeProjectExportExpectation,
  cancelled: () => boolean = () => false,
): AsyncGenerator<NativeProjectImageReceipt> {
  const check = () => {
    if (cancelled()) throw new Error("Native image receipt read cancelled");
  };
  if (!receipt.image_receipts) {
    for (const [index, image] of (receipt.images ?? []).entries()) {
      check();
      yield parseNativeProjectImage(image, index, expected);
    }
    if (receipt.images?.length !== expected.frames)
      throw new Error("Native image receipts incomplete");
    return;
  }
  const identity = receipt.image_receipts;
  const before = await lstat(identity.path);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== identity.bytes)
    throw new Error("Native image receipt file metadata differs");
  const file = await open(identity.path, "r");
  try {
    const opened = await file.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      throw new Error("Native image receipt file changed while opening");
    let pending = Buffer.alloc(0),
      bytes = 0,
      index = 0;
    const hash = createHash("sha256"),
      chunk = Buffer.alloc(65536);
    for (;;) {
      check();
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > identity.bytes) throw new Error("Native image receipt file grew");
      hash.update(chunk.subarray(0, bytesRead));
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let end = pending.indexOf(10);
      while (end >= 0) {
        check();
        if (end === 0 || end > 1024) throw new Error("Native image receipt line exceeds its bound");
        const image = parseNativeProjectImage(
          JSON.parse(pending.subarray(0, end).toString("utf8")),
          index++,
          expected,
        );
        pending = pending.subarray(end + 1);
        yield image;
        end = pending.indexOf(10);
      }
      if (pending.length > 1024) throw new Error("Native image receipt line exceeds its bound");
    }
    const after = await file.stat();
    if (
      pending.length ||
      index !== expected.frames ||
      index !== identity.frames ||
      bytes !== identity.bytes ||
      hash.digest("hex") !== identity.sha256 ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    )
      throw new Error("Native image receipt file integrity differs");
  } finally {
    await file.close();
  }
}
