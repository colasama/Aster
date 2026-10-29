// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NativePreviewClient } from "./native-preview-client";

const ready = {
  type: "ready",
  schema_version: 1,
  generation: 1,
  width: 67,
  height: 35,
  slots: 2,
  source: { kind: "plan", sha256: "a".repeat(64) },
  adapter: { name: "controlled transport witness" },
};
const session = (
  frame = "{type:'frame',sequence:c.sequence,generation:c.generation,time:c.time??null,nt_handle:[1,0,0,0,0,0,0,0],render_and_share_ms:1}",
  source: object = ready.source,
) => `
  const ready=JSON.stringify(${JSON.stringify({ ...ready, source })})+'\\n';
  process.stdout.write(ready.slice(0,17));
  setImmediate(()=>process.stdout.write(ready.slice(17)));
  const lines=require('node:readline').createInterface({input:process.stdin});
  lines.on('line',line=>{
    const c=JSON.parse(line);
    const value=c.type==='replace'?{...JSON.parse(ready),generation:c.generation}:c.type==='present'?${frame}:c.type==='release'?{type:'released',sequence:c.sequence}:{type:'stopped'};
    process.stdout.write(JSON.stringify(value)+'\\n');
    if(c.type==='shutdown')process.exit(0);
  });
`;
const open = (script: string, timeoutMs = 2000) =>
  new NativePreviewClient({
    platform: "win32",
    executable: process.execPath,
    args: ["-e", script, "--"],
    timeoutMs,
  });

describe("shared preview control ownership", () => {
  it("bounds outstanding leases and preserves a usable session after rejected local requests", async () => {
    const client = open(session());
    try {
      expect(await client.ready).toEqual(ready);
      const first = await client.present();
      const second = await client.present();
      await expect(client.present()).rejects.toThrow(/leases exhausted/);
      await expect(client.close()).rejects.toThrow(/Drain GPU references/);
      await expect(client.release(99)).rejects.toThrow(/Unknown/);
      await client.release(first.sequence);
      await expect(client.release(first.sequence)).rejects.toThrow(/Unknown/);
      const third = await client.present();
      expect(third.sequence).toBe(3);
      await Promise.all([client.release(second.sequence), client.release(third.sequence)]);
      await client.close();
    } finally {
      client.abort("Test cleanup");
    }
  });

  it("requires explicit finite project times and preserves exact unquantized seeks", async () => {
    const source = {
      kind: "project",
      authored_sha256: "b".repeat(64),
      runtime_sha256: "c".repeat(64),
      scope: "snapshot:7",
      revision: 7,
      composition_id: "main",
    };
    const client = open(session(undefined, source));
    try {
      expect((await client.ready).source).toEqual(source);
      for (const time of [undefined, Number.NaN, Infinity])
        await expect(client.present(time)).rejects.toThrow(/time/);
      for (const time of [0.123456789, 3.5, -1, 0.123456789]) {
        const frame = await client.present(time);
        expect(frame.time).toBe(time);
        await client.release(frame.sequence);
      }
      await client.close();
    } finally {
      client.abort("Test cleanup");
    }
  });

  it("drains leases before snapshot replacement and rejects stale-generation frames", async () => {
    const source = {
      kind: "project",
      authored_sha256: "b".repeat(64),
      runtime_sha256: "c".repeat(64),
      scope: "snapshot:7",
      revision: 7,
      composition_id: "main",
    };
    const client = open(session(undefined, source));
    try {
      const first = await client.present(0);
      await expect(client.replace("project.json", "request.json")).rejects.toThrow(/Drain/);
      await client.release(first.sequence);
      expect((await client.replace("project.json", "request.json")).generation).toBe(2);
      const next = await client.present(0.25);
      expect(next.generation).toBe(2);
      expect(next.sequence).toBe(first.sequence + 1);
      await client.release(next.sequence);
      await client.close();
    } finally {
      client.abort("Test cleanup");
    }
    const stale = open(
      session(
        "{type:'frame',sequence:c.sequence,generation:1,time:c.time,nt_handle:[1,0,0,0,0,0,0,0],render_and_share_ms:1}",
        source,
      ),
    );
    try {
      await stale.replace("project.json", "request.json");
      await expect(stale.present(0)).rejects.toThrow(/identity/);
      await expect(stale.present(0)).rejects.toThrow(/identity/);
    } finally {
      stale.abort("Test cleanup");
    }
  });

  it("waits for initial readiness before immediate clean shutdown", async () => {
    const client = open(session());
    try {
      await client.close();
    } finally {
      client.abort("Test cleanup");
    }
  });

  it.each([
    "process.stdout.write('{}\\n')",
    "process.stdout.write('x'.repeat(65537))",
    `process.stdout.write(${JSON.stringify(`${JSON.stringify(ready)}\n{}\n`)})`,
    "process.stdout.write('{');process.exit(4)",
  ])("fails closed on malformed readiness", async (script) => {
    const client = open(script);
    try {
      await expect(client.ready).rejects.toThrow();
      await expect(client.present()).rejects.toThrow();
    } finally {
      client.abort("Test cleanup");
    }
  });

  it.each([
    "{type:'frame',sequence:c.sequence+1,nt_handle:[1,0,0,0,0,0,0,0],render_and_share_ms:0}",
    "{type:'frame',sequence:c.sequence,nt_handle:[1,0,0,0],render_and_share_ms:0}",
    "{type:'frame',sequence:c.sequence,nt_handle:[0,0,0,0,0,0,0,0],render_and_share_ms:0}",
    "{type:'frame',sequence:c.sequence,nt_handle:[256,0,0,0,0,0,0,0],render_and_share_ms:0}",
  ])("poisons the session on an invalid frame identity or handle", async (frame) => {
    const client = open(session(frame));
    try {
      await client.ready;
      await expect(client.present()).rejects.toThrow(/identity/);
      await expect(client.present()).rejects.toThrow(/identity/);
    } finally {
      client.abort("Test cleanup");
    }
  });

  it("bounds queued controls while a ready child stops answering", async () => {
    const client = open(
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(ready)}\n`)});process.stdin.resume();`,
      300,
    );
    try {
      await client.ready;
      const controls = Array.from({ length: 8 }, () => client.present());
      const settled = Promise.allSettled(controls);
      await expect(client.present()).rejects.toThrow(/queue is full/);
      expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    } finally {
      client.abort("Test cleanup");
    }
  });
});
