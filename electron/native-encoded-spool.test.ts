// @vitest-environment node
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { NativeEncodedSpool } from "./native-encoded-spool";
import type { NativeSessionReply } from "./native-render-protocol";

const video = {
  size: { width: 320, height: 180 },
  frame_rate: { numerator: 30000, denominator: 1001 },
  bitrate_bps: 8_000_000,
};
const roots: string[] = [];
const spools: NativeEncodedSpool[] = [];
afterEach(async () => {
  await Promise.all(spools.splice(0).map((spool) => spool.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(maxBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), "aster-encoded-spool-test-"));
  roots.push(root);
  const spool = await NativeEncodedSpool.create(root, 2, video, maxBytes);
  spools.push(spool);
  return { root, spool };
}
function reply(frame: number | null, packets: number[]): NativeSessionReply {
  const payload = Buffer.concat(packets.map(() => Buffer.from([0, 0, 0, 1, 101, 23])));
  return {
    version: 1,
    request_id: (frame ?? 2) + 1,
    payload_bytes: payload.length,
    payload,
    response: {
      type: "encoded",
      submitted_frame: frame,
      complete: frame === null,
      packets: packets.map((index) => {
        const timestamp = (BigInt(index) * 10010000000n) / 30000n;
        return {
          frame_index: index,
          timestamp_100ns: Number(timestamp),
          duration_100ns: Number((BigInt(index + 1) * 10010000000n) / 30000n - timestamp),
          payload_bytes: 6,
        };
      }),
      encoder: { accepted_frames: 2, encoded_frames: 2, drain_completed: true, cancelled: false },
    },
  };
}

it("retains delayed hardware packets privately until complete drain, then reads independent bytes", async () => {
  const { spool, root } = await fixture();
  await spool.append(0, reply(0, []));
  const second = reply(1, [0]);
  await spool.append(1, second);
  second.payload.fill(255);
  await spool.seal(reply(null, [1]));
  expect(spool.statistics).toMatchObject({ frames: 2, packets: 2, sealed: true });
  expect((await spool.read(0)).payload.length).toBe(0);
  const read = await spool.read(1);
  expect(read.payload).toEqual(Buffer.from([0, 0, 0, 1, 101, 23]));
  read.payload.fill(33);
  expect((await spool.read(1)).payload[0]).toBe(0);
  expect((await spool.read(2)).response.complete).toBe(true);
  await spool.dispose();
  expect(await readdir(root)).toEqual([]);
});

it.each([
  "unsealed",
  "missing-frame",
  "wrong-order",
  "clock",
  "payload",
  "drain",
  "budget",
  "tamper",
  "cancel",
])("rejects %s and removes all owned packets", async (scenario) => {
  const { spool, root } = await fixture(scenario === "budget" ? 1 : undefined);
  if (scenario === "wrong-order")
    await expect(spool.append(1, reply(1, []))).rejects.toThrow(/order/);
  else if (scenario === "budget")
    await expect(spool.append(0, reply(0, []))).rejects.toThrow(/budget/);
  else if (scenario === "cancel") {
    const pending = spool.append(0, reply(0, []));
    const observed = expect(pending).rejects.toThrow(/cancelled/);
    await spool.dispose();
    await observed;
  } else {
    await spool.append(0, reply(0, []));
    if (scenario === "unsealed") await expect(spool.read(0)).rejects.toThrow(/not ready/);
    else if (scenario === "missing-frame")
      await expect(spool.seal(reply(null, [0, 1]))).rejects.toThrow(/every frame/);
    else {
      const second = reply(1, [0]);
      if (scenario === "clock") {
        (second.response.packets as { timestamp_100ns: number }[])[0].timestamp_100ns = 1;
        await expect(spool.append(1, second)).rejects.toThrow(/clock/);
      } else if (scenario === "payload") {
        second.payload.fill(255);
        await expect(spool.append(1, second)).rejects.toThrow(/Annex-B/);
      } else {
        await spool.append(1, second);
        const drain = reply(null, [1]);
        if (scenario === "drain") {
          drain.response.encoder = { drain_completed: false };
          await expect(spool.seal(drain)).rejects.toThrow(/drain/);
        } else {
          await spool.seal(drain);
          const [directory] = await readdir(root);
          await writeFile(join(root, directory, "packets.bin"), "changed");
          await expect(spool.read(0)).rejects.toThrow(/size changed/);
        }
      }
    }
  }
  await spool.dispose();
  expect(await readdir(root)).toEqual([]);
  await expect(spool.read(0)).rejects.toThrow(/closed/);
});
