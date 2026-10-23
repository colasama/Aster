import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { MAX_RENDER_SNAPSHOT_BYTES } from "../src/core/rendering/render-queue.js";

/** Reuse native schema migrations; only the private job copy is upgraded. */
export async function normalizeNativeQueueDocument(
  directory: string,
  snapshot: string,
  renderer: string,
): Promise<unknown> {
  const input = join(directory, "authored-input.json"),
    output = join(directory, "normalized-input.json");
  await writeFile(input, snapshot, { flag: "wx" });
  const { stdout } = await promisify(execFile)(
    renderer,
    [
      "normalize-project",
      "--project",
      input,
      "--out",
      output,
      "--max-input-bytes",
      String(MAX_RENDER_SNAPSHOT_BYTES),
    ],
    { windowsHide: true, timeout: 120000, maxBuffer: 65536 },
  );
  const receipt = JSON.parse(stdout.trim());
  const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  const info = await stat(output);
  if (
    receipt.status !== "passed" ||
    receipt.authored_sha256 !== digest(snapshot) ||
    !info.isFile() ||
    info.size > MAX_RENDER_SNAPSHOT_BYTES ||
    info.size !== receipt.normalized_bytes
  )
    throw new Error("Native queue normalization receipt differs");
  const bytes = await readFile(output);
  if (bytes.length > MAX_RENDER_SNAPSHOT_BYTES || digest(bytes) !== receipt.normalized_sha256)
    throw new Error("Normalized queue document changed");
  const document = JSON.parse(bytes.toString("utf8"));
  if (document.schemaVersion !== 10)
    throw new Error("Native queue normalization did not produce the current schema");
  return document;
}
