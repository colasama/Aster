import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";

/** A single in-flight control owns its binary reply until every bounded payload is written. */
export class NativeRasterWire {
  readonly socket: Socket;
  #buffer = Buffer.alloc(0);
  #busy = false;
  constructor(
    address: string,
    readonly maximumJson: number,
    readonly command: (value: unknown) => Promise<void>,
    readonly fail: (error?: Error) => void,
  ) {
    const match = /^127\.0\.0\.1:(\d+)$/.exec(address);
    assert(match && Number(match[1]) > 0 && Number(match[1]) <= 65535, "Invalid raster endpoint");
    this.socket = createConnection({ host: "127.0.0.1", port: Number(match[1]) });
    this.socket.setNoDelay(true);
    this.socket.on("error", (error) => fail(error));
    this.socket.on("close", () => fail());
    this.socket.on("data", (chunk: Buffer) => {
      try {
        assert(!this.#busy, "Overlapping raster controls");
        assert(
          this.#buffer.length + chunk.length <= maximumJson + 4,
          "Raster control byte budget exceeded",
        );
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        if (this.#buffer.length < 4) return;
        const length = this.#buffer.readUInt32LE(0);
        assert(length > 0 && length <= maximumJson, "Invalid raster control length");
        if (this.#buffer.length < length + 4) return;
        assert.equal(this.#buffer.length, length + 4, "Pipelined raster controls are not admitted");
        const value = JSON.parse(this.#buffer.subarray(4).toString("utf8"));
        this.#buffer = Buffer.alloc(0);
        this.#busy = true;
        void this.command(value)
          .then(() => {
            this.#busy = false;
          })
          .catch((error) => fail(error));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async send(value: unknown, payloads: readonly Buffer[] = []) {
    const json = Buffer.from(JSON.stringify(value));
    assert(json.length > 0 && json.length <= this.maximumJson, "Raster reply byte budget exceeded");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length);
    for (const bytes of [header, json, ...payloads]) {
      await new Promise<void>((resolve, reject) => {
        this.socket.write(bytes, (error) => (error ? reject(error) : resolve()));
      });
    }
  }

  dispose() {
    this.socket.destroy();
  }
}
