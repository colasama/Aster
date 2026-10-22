import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { RasterServiceFrame } from "../src/renderer/native-project/raster-service-protocol.js";

interface PayloadIdentity {
  sha256: string;
  byteLength: number;
}

/** Only the immediately preceding frame's metadata survives; pixel ownership remains in Rust. */
export class NativeRasterPayloads {
  #previous = new Map<string, PayloadIdentity>();

  known(value: unknown): string[] {
    assert(Array.isArray(value) && value.length <= 65536);
    return value.filter((file) => {
      assert(typeof file === "string" && /^[a-f0-9]{64}\.bin$/.test(file));
      return this.#previous.has(file);
    });
  }

  prepare(items: RasterServiceFrame["pixels"], known: string[], maximumBytes: number) {
    assert(Array.isArray(items) && items.length <= 65536);
    const admitted = new Set(known);
    const identities = new Map<string, PayloadIdentity>();
    const payloads = new Map<string, Buffer>();
    let total = 0;
    const pixels = items.map((item) => {
      assert(/^[a-f0-9]{64}$/.test(item.pixels.message.hash));
      const file = `${item.pixels.message.hash}.bin`;
      let identity: PayloadIdentity;
      if (item.pixels.bytes === undefined) {
        const cached = this.#previous.get(file);
        assert(admitted.has(file) && cached, "Raster payload was not advertised as resident");
        identity = cached;
      } else {
        assert(item.pixels.bytes instanceof Uint8Array);
        const bytes = Buffer.from(item.pixels.bytes);
        identity = {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteLength: bytes.length,
        };
        if (admitted.has(file)) {
          assert.deepEqual(identity, this.#previous.get(file), "Conflicting resident payload");
        } else payloads.set(file, bytes);
      }
      const previous = identities.get(file);
      if (previous) assert.deepEqual(identity, previous, "Conflicting raster payload");
      else {
        total += identity.byteLength;
        assert(total <= maximumBytes, "Raster payload budget exceeded");
        identities.set(file, identity);
      }
      return { frame: item.frame, message: item.pixels.message, file, sha256: identity.sha256 };
    });
    return { pixels, payloads, identities };
  }

  commit(identities: Map<string, PayloadIdentity>) {
    this.#previous = identities;
  }
}
