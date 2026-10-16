import { createHash } from "node:crypto";
import type { NativeFramePacket } from "../src/core/rendering/native-export-protocol.js";
import { copyWireValue } from "../src/core/rendering/wire-copy.js";
import {
  type OwnedNativeFrame,
  type OwnedNativeResource,
  ownNativeFrame,
} from "./native-export-input.js";

export interface NativeFrameAdmissionLimits {
  maxBytes: number;
  maxResources: number;
  maxFrameBytes: number;
  frameCount: number;
}

/** Tracks the bounded input history while native admission retains only compressed output. */
export class NativeFrameAdmission {
  readonly #limits: NativeFrameAdmissionLimits;
  readonly #resources = new Map<string, string>();
  #retained = new Map<string, OwnedNativeResource>();
  #frames = 0;
  #bytes = 0;
  #sealed = false;
  #closed = false;
  #pending?: Promise<void>;
  #disposal?: Promise<void>;
  readonly #timings = { ownInputMs: 0, authenticateMs: 0, retainMetadataMs: 0 };

  constructor(limits: NativeFrameAdmissionLimits) {
    for (const [value, minimum, maximum] of [
      [limits.maxBytes, 32, 32 * 1024 ** 3],
      [limits.maxResources, 1, 262144],
      [limits.maxFrameBytes, 32, 67_108_864],
      [limits.frameCount, 1, 1_000_000],
    ])
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new Error("Invalid native frame admission limits");
    this.#limits = { ...limits };
  }

  get statistics() {
    return {
      frames: this.#frames,
      resources: this.#resources.size,
      bytes: this.#bytes,
      sealed: this.#sealed,
    };
  }

  get timings() {
    return { ...this.#timings };
  }

  async append(
    frame: number,
    input: NativeFramePacket,
    admit: (owned: OwnedNativeFrame) => Promise<void>,
  ): Promise<void> {
    if (
      this.#closed ||
      this.#sealed ||
      this.#pending ||
      frame !== this.#frames ||
      frame >= this.#limits.frameCount
    )
      throw new Error("Native preflight frame is out of order or admission is unavailable");
    let stage = performance.now();
    const owned = ownNativeFrame(input, this.#limits.maxFrameBytes, this.#retained);
    this.#timings.ownInputMs += performance.now() - stage;
    let release!: () => void;
    this.#pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      stage = performance.now();
      const additions = new Map<string, string>();
      let addedBytes = owned.plan.length;
      for (const packet of owned.resources) {
        if (packet.retainedBytes !== undefined) {
          if (!this.#resources.has(packet.message.hash))
            throw new Error("Native retained resource has no admitted identity");
          continue;
        }
        const digest = createHash("sha256")
          .update(packet.control)
          .update("\n")
          .update(packet.bytes)
          .digest("hex");
        const previous = this.#resources.get(packet.message.hash);
        if (previous !== undefined && previous !== digest)
          throw new Error("Native resource identity changed during preflight");
        if (previous === undefined) {
          additions.set(packet.message.hash, digest);
          addedBytes += packet.control.length + 1 + packet.bytes.length;
        }
      }
      // Preserve the admitted-input budget independently of compressed size or storage strategy.
      // The discarded spool index has a fixed 64-byte plan digest and validated 64-byte
      // resource hashes. Count its exact JSON length without hashing the plan or allocating
      // the index; Rust still validates the admitted plan and its resource dependencies.
      addedBytes += 90 + owned.resources.length * 66 + Math.max(0, owned.resources.length - 1);
      if (
        this.#bytes + addedBytes > this.#limits.maxBytes ||
        this.#resources.size + additions.size > this.#limits.maxResources
      )
        throw new Error("Native admission exceeds its input budget");
      this.#timings.authenticateMs += performance.now() - stage;
      stage = performance.now();
      // Snapshot new metadata before handing owned inputs to the consumer. References reuse
      // private snapshots that never escape through the consumer's independently copied input.
      const nextRetained = new Map(
        owned.resources.map((packet) => [
          packet.message.hash,
          (packet.retainedBytes !== undefined && this.#retained.get(packet.message.hash)) || {
            message: copyWireValue(packet.message),
            control: Buffer.from(packet.control),
            bytes: Buffer.alloc(0),
            retainedBytes: packet.retainedBytes ?? packet.bytes.length,
          },
        ]),
      );
      this.#timings.retainMetadataMs += performance.now() - stage;
      await admit(owned);
      if (this.#closed) throw new Error("Native preflight was cancelled");
      for (const [hash, digest] of additions) this.#resources.set(hash, digest);
      this.#retained = nextRetained;
      this.#bytes += addedBytes;
      this.#frames++;
    } catch (error) {
      this.#closed = true;
      throw error;
    } finally {
      this.#pending = undefined;
      release();
    }
  }

  seal(): void {
    if (this.#closed || this.#pending || this.#sealed || this.#frames !== this.#limits.frameCount)
      throw new Error("Native preflight has not admitted the complete job");
    this.#sealed = true;
  }

  dispose(): Promise<void> {
    this.#closed = true;
    this.#disposal ??= (async () => {
      await this.#pending;
      this.#resources.clear();
      this.#retained.clear();
    })();
    return this.#disposal;
  }
}
