// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NativeRenderClient } from "./native-render-client";
import { NativeResourceReplyReader, type NativeResourceRequest } from "./native-render-protocol";

const requests: NativeResourceRequest[] = [
  { command: { type: "evict_resource", hash: "1".repeat(64) } },
  {
    command: {
      type: "put_resource",
      resource: { hash: "2".repeat(64), kind: "buffer", descriptor: {} },
      payload_bytes: 32,
    },
    payload: Buffer.alloc(32, 7),
  },
];
const replies = ["resource_evicted", "resource_stored"].map((type, index) => ({
  version: 1,
  request_id: index + 4,
  payload_bytes: 0,
  response: { type },
}));
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const reader = () =>
  new NativeResourceReplyReader(
    4,
    requests.map((request) => request.command),
    1024,
  );

describe("bounded resource transactions", () => {
  it("accepts every fragmented or coalesced acknowledgement boundary", () => {
    const wire = Buffer.concat(replies.map(encode));
    for (let split = 1; split < wire.length; split++) {
      const current = reader();
      expect(current.push(wire.subarray(0, split))).toBeUndefined();
      expect(current.push(wire.subarray(split))?.request_id).toBe(5);
      expect(() => current.push(encode(replies[1]))).toThrow(/unsolicited/);
    }
    expect(reader().push(wire)?.request_id).toBe(5);
  });

  it.each([
    { ...replies[1], request_id: 6 },
    { ...replies[1], payload_bytes: 1 },
    { ...replies[1], response: { type: "resource_evicted" } },
    { ...replies[1], response: { type: "error", message: "resource rejected" } },
  ])("rejects invalid intermediate identities, errors and payloads", (invalid) => {
    expect(() => reader().push(Buffer.concat([encode(replies[0]), encode(invalid)]))).toThrow();
  });

  it("rejects oversized and trailing acknowledgements", () => {
    expect(() => reader().push(Buffer.alloc(1025, 32))).toThrow(/control exceeds/);
    expect(() =>
      reader().push(Buffer.concat([...replies.map(encode), encode(replies[1])])),
    ).toThrow(/trailing/);
  });

  it("sends all resources before waiting, owns bytes and reserves ordered request IDs", async () => {
    const client = new NativeRenderClient({
      executable: process.execPath,
      args: [
        "-e",
        `
        let input=Buffer.alloc(0), replies=[], expected=1;
        process.stdin.on('data', chunk=>{
          input=Buffer.concat([input,chunk]);
          for(;;){
            const newline=input.indexOf(10); if(newline<0)return;
            const request=JSON.parse(input.subarray(0,newline)), command=request.command;
            const count=command.payload_bytes||0; if(input.length<newline+1+count)return;
            if(request.request_id!==expected++)process.exit(4);
            if(count && !input.subarray(newline+1,newline+1+count).every(b=>b===7))process.exit(3);
            input=input.subarray(newline+1+count);
            const type=command.type==='shutdown'?'closed':command.type==='put_resource'?'resource_stored':'resource_evicted';
            replies.push(JSON.stringify({version:1,request_id:request.request_id,payload_bytes:0,response:{type}})+'\\n');
            if(replies.length===2 || type==='closed'){process.stdout.write(replies.join(''));replies=[];}
          }
        });
      `,
      ],
      requestTimeoutMs: 3000,
    });
    try {
      const input = structuredClone(requests);
      const pending = client.requestResources(input);
      input[1].payload?.fill(8);
      await expect(client.request({ type: "cancel_export" })).rejects.toThrow(/pending/);
      await pending;
      await client.shutdown();
    } finally {
      await client.dispose();
    }
  });

  it("bounds batch count and aggregate bytes before writing, and cancels backpressure", async () => {
    const client = new NativeRenderClient({
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      maxPayloadBytes: 8 * 1024 ** 2,
    });
    try {
      await expect(client.requestResources(Array(65).fill(requests[0]))).rejects.toThrow(/count/);
      const put: NativeResourceRequest = {
        command: {
          ...requests[1].command,
          type: "put_resource",
          resource: { hash: "2".repeat(64), kind: "buffer", descriptor: {} },
          payload_bytes: 8 * 1024 ** 2,
        },
        payload: Buffer.alloc(8 * 1024 ** 2),
      };
      await expect(client.requestResources([put, requests[1]])).rejects.toThrow(/aggregate/);
      const pending = client.requestResources([put]);
      const rejected = expect(pending).rejects.toThrow(/disposed/);
      await client.dispose();
      await rejected;
    } finally {
      await client.dispose();
    }
  });
});
