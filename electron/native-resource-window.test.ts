// @vitest-environment node
import { expect, it, vi } from "vitest";
import { ownNativeFrame } from "./native-export-input";
import type { NativeResourceRequest } from "./native-render-protocol";
import { NativeResourceWindow } from "./native-resource-window";

it("keeps references on the native device and rejects expired references before side effects", async () => {
  const client = {
    requestResources: vi.fn(async (_requests: readonly NativeResourceRequest[]) => ({
      version: 1 as const,
      request_id: 1,
      payload_bytes: 0,
      response: { type: "resource_stored" },
      payload: Buffer.alloc(0),
    })),
  };
  const window = new NativeResourceWindow(client);
  const original = ownNativeFrame({
    plan: new ArrayBuffer(32),
    resources: [
      {
        message: {
          type: "put_resource",
          hash: "1".repeat(64),
          kind: "buffer",
          descriptor: { element_type: "u8", element_count: 16, byte_length: 16 },
        },
        bytes: new ArrayBuffer(16),
      },
    ],
  });
  await window.install(original);
  expect(client.requestResources).toHaveBeenCalledTimes(1);
  expect(client.requestResources.mock.calls[0][0][0].payload).toHaveLength(16);
  const retained = {
    ...original,
    resources: original.resources.map((packet) => ({
      ...packet,
      bytes: Buffer.alloc(0),
      retainedBytes: 16,
    })),
  };
  await window.install(retained);
  expect(client.requestResources).toHaveBeenCalledTimes(1);
  await window.clear();
  expect(client.requestResources).toHaveBeenCalledTimes(2);
  expect(client.requestResources.mock.calls[1][0]).toEqual([
    { command: { type: "evict_resource", hash: "1".repeat(64) } },
  ]);
  await expect(window.install(retained)).rejects.toThrow(/absent from the sidecar window/);
  expect(client.requestResources).toHaveBeenCalledTimes(2);
});
