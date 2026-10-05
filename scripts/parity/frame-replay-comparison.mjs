import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomicJson } from "../migration/report.mjs";
import { encodeRgbaPng } from "./png.mjs";

/** Reject before candidate publication and retain both lossless inputs when replay differs. */
export async function compareFrameReplay(directory, payload, replay) {
  if (payload.productionPixels === undefined) return undefined;
  const production =
    payload.productionPixels instanceof ArrayBuffer
      ? new Uint8Array(payload.productionPixels)
      : payload.productionPixels;
  assert.equal(production.length, replay.length, "Production/replay byte lengths differ");
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const result = {
    profile: "exact",
    compared_bytes: replay.length,
    production_sha256: digest(production),
    replay_sha256: digest(replay),
    exact: true,
  };
  if (Buffer.from(production).equals(Buffer.from(replay))) return result;
  result.exact = false;
  let differentBytes = 0,
    firstDifference = -1;
  for (let i = 0; i < replay.length; i++)
    if (replay[i] !== production[i]) {
      differentBytes++;
      if (firstDifference === -1) firstDifference = i;
    }
  const evidence = join(directory, "replay-mismatches", payload.caseId, String(payload.frame));
  await mkdir(evidence, { recursive: true });
  for (const [name, pixels] of [
    ["production", production],
    ["replay", replay],
  ])
    await writeFile(
      join(evidence, `${name}.png`),
      encodeRgbaPng(payload.width, payload.height, pixels),
      { flag: "wx" },
    );
  await writeAtomicJson(join(evidence, "comparison.json"), {
    ...result,
    different_bytes: differentBytes,
    first_difference: firstDifference,
    frame: payload.frame,
  });
  throw new Error(
    `Supplied frame differs at byte ${firstDifference}: ${replay[firstDifference]} != ${production[firstDifference]}; ${differentBytes} bytes differ. Evidence: ${evidence}`,
  );
}
