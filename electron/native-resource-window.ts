import type { OwnedNativeFrame } from "./native-export-input.js";
import type { NativeRenderClient } from "./native-render-client.js";
import type { NativeResourceRequest } from "./native-render-protocol.js";

/** Retain only the current frame's authenticated resource closure in the sidecar. */
export class NativeResourceWindow {
  readonly #client: Pick<NativeRenderClient, "requestResources">;
  readonly #installed = new Set<string>();
  #busy = false;
  #failed = false;

  constructor(client: Pick<NativeRenderClient, "requestResources">) {
    this.#client = client;
  }

  async install(frame: OwnedNativeFrame): Promise<void> {
    if (this.#busy || this.#failed) throw new Error("Native resource window is unavailable");
    this.#busy = true;
    try {
      const required = new Set(frame.resources.map((packet) => packet.message.hash));
      if (required.size !== frame.resources.length)
        throw new Error("Native frame has duplicate resources");
      if (
        frame.resources.some(
          (packet) =>
            packet.retainedBytes !== undefined && !this.#installed.has(packet.message.hash),
        )
      )
        throw new Error("Native retained resource is absent from the sidecar window");
      let batch: NativeResourceRequest[] = [];
      let payloadBytes = 0;
      const flush = async () => {
        if (!batch.length) return;
        await this.#client.requestResources(batch);
        for (const { command } of batch) {
          if (command.type === "evict_resource") this.#installed.delete(command.hash);
          else this.#installed.add(command.resource.hash);
        }
        batch = [];
        payloadBytes = 0;
      };
      const enqueue = async (request: NativeResourceRequest) => {
        const bytes = request.payload?.byteLength ?? 0;
        if (batch.length === 64 || payloadBytes + bytes > 67_108_864) await flush();
        batch.push(request);
        payloadBytes += bytes;
      };
      for (const hash of [...this.#installed].reverse()) {
        if (required.has(hash)) continue;
        await enqueue({ command: { type: "evict_resource", hash } });
      }
      const order: Record<string, number> = { media_source: 0, media_frame: 1, raster_pixels: 2 };
      const packets = [...frame.resources].sort(
        (a, b) => (order[a.message.kind] ?? 3) - (order[b.message.kind] ?? 3),
      );
      for (const packet of packets) {
        if (this.#installed.has(packet.message.hash)) continue;
        const { type, ...resource } = packet.message;
        await enqueue({
          command: { type, resource, payload_bytes: packet.bytes.length },
          payload: packet.bytes,
        });
      }
      await flush();
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  /** End a preparation-only resource lease before measured admission authenticates fresh inputs. */
  async clear(): Promise<void> {
    await this.install({ plan: Buffer.alloc(0), resources: [] });
  }
}
