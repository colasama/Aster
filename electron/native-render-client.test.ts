// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NativeRenderClient } from "./native-render-client";
import { NativeReplyReader, type NativeSessionCommand } from "./native-render-protocol";

const command: NativeSessionCommand = { type: "render_frame", plan_bytes: 32, frame_index: 0 };
const payload = Buffer.from([0, 0, 0, 1, 0x65, 10, 0, 0, 1, 0x41]);
const envelope = {
  version: 1,
  request_id: 1,
  payload_bytes: payload.length,
  response: {
    type: "encoded",
    complete: false,
    submitted_frame: 0,
    packets: [
      { frame_index: 0, timestamp_100ns: 0, duration_100ns: 333333, payload_bytes: payload.length },
    ],
  },
};
const wire = Buffer.concat([Buffer.from(`${JSON.stringify(envelope)}\n`), payload]);

describe("bounded native sidecar transport", () => {
  it("reassembles every split, including newlines inside Annex-B", () => {
    for (let split = 1; split < wire.length; split++) {
      const reader = new NativeReplyReader(1, command, 1024, 1024);
      expect(reader.push(wire.subarray(0, split))).toBeUndefined();
      expect(reader.push(wire.subarray(split))?.payload).toEqual(payload);
    }
    const bytewise = new NativeReplyReader(1, command, 1024, 1024);
    for (let i = 0; i < wire.length - 1; i++)
      expect(bytewise.push(wire.subarray(i, i + 1))).toBeUndefined();
    expect(bytewise.push(wire.subarray(-1))?.payload).toEqual(payload);
  });

  it("rejects oversized declarations before receiving or allocating payload", () => {
    const reader = new NativeReplyReader(1, command, 1024, 64);
    expect(() =>
      reader.push(Buffer.from(`${JSON.stringify({ ...envelope, payload_bytes: 65 })}\n`)),
    ).toThrow(/invalid envelope/);
    expect(() => new NativeReplyReader(1, command, 16, 64).push(Buffer.alloc(17, 32))).toThrow(
      /control exceeds/,
    );
  });

  it.each([
    { ...envelope, request_id: 2 },
    { ...envelope, response: { ...envelope.response, complete: true } },
    { ...envelope, response: { ...envelope.response, submitted_frame: 1 } },
    { ...envelope, response: { ...envelope.response, packets: [] } },
    { ...envelope, response: { ...envelope.response, type: "closed" } },
  ])("rejects mismatched identities, completion and packet lengths", (value) => {
    const reader = new NativeReplyReader(1, command, 1024, 1024);
    expect(() =>
      reader.push(Buffer.concat([Buffer.from(`${JSON.stringify(value)}\n`), payload])),
    ).toThrow();
  });

  it("rejects trailing bytes and unsolicited second replies", () => {
    expect(() =>
      new NativeReplyReader(1, command, 1024, 1024).push(Buffer.concat([wire, Buffer.from("x")])),
    ).toThrow(/trailing/);
    const reader = new NativeReplyReader(1, command, 1024, 1024);
    expect(reader.push(wire)?.payload).toEqual(payload);
    expect(() => reader.push(wire)).toThrow(/unsolicited/);
  });

  it("preserves owned inputs, waits for a reply, and shuts down the actual child", async () => {
    const client = new NativeRenderClient({
      executable: process.execPath,
      args: [
        "-e",
        `
      let input=Buffer.alloc(0);
      process.stdin.on('data',chunk=>{
        input=Buffer.concat([input,chunk]);
        const newline=input.indexOf(10); if(newline<0)return;
        const request=JSON.parse(input.subarray(0,newline));
        const count=request.command.plan_bytes||0;
        if(input.length<newline+1+count)return;
        if(count && !input.subarray(newline+1).every(b=>b===7))process.exit(3);
        const response=request.command.type==='shutdown'?{type:'closed'}:{type:'frame_checked'};
        input=input.subarray(newline+1+count);
        setTimeout(()=>process.stdout.write(JSON.stringify({version:1,request_id:request.request_id,payload_bytes:0,response})+'\\n'),20);
      });
    `,
      ],
    });
    try {
      const plan = Buffer.alloc(32, 7);
      const pending = client.request({ type: "check_frame", plan_bytes: 32 }, plan);
      plan.fill(8);
      await expect(client.request({ type: "shutdown" })).rejects.toThrow(/pending/);
      expect((await pending).response.type).toBe("frame_checked");
      await client.shutdown();
    } finally {
      await client.dispose();
    }
  });

  it.each(["truncated", "crash", "invalid"])("fails closed on a %s child reply", async (mode) => {
    const client = new NativeRenderClient({
      executable: process.execPath,
      args: [
        "-e",
        `
      process.stdin.once('data',()=>{
        if('${mode}'==='truncated')process.stdout.write('{' );
        if('${mode}'==='invalid')process.stdout.write('{}\\n');
        process.exitCode=9; process.stdin.destroy();
      });
    `,
      ],
    });
    try {
      await expect(client.request({ type: "cancel_export" })).rejects.toThrow();
      await expect(client.request({ type: "shutdown" })).rejects.toThrow();
    } finally {
      await client.dispose();
    }
  });

  it("terminates a hung request and refuses an unbounded command queue", async () => {
    const client = new NativeRenderClient({
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      requestTimeoutMs: 500,
    });
    try {
      const request = client.request({ type: "cancel_export" });
      await expect(client.request({ type: "shutdown" })).rejects.toThrow(/pending/);
      await expect(request).rejects.toThrow(/timed out/);
    } finally {
      await client.dispose();
    }
  });

  it("out-of-band cancellation releases a backpressured binary write", async () => {
    const client = new NativeRenderClient({
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
    });
    const request = client.request(
      { type: "check_frame", plan_bytes: 8 * 1024 * 1024 },
      Buffer.alloc(8 * 1024 * 1024),
    );
    const rejected = expect(request).rejects.toThrow(/disposed/);
    await client.dispose();
    await rejected;
  });
});
