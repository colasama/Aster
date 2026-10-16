import { createHash } from "node:crypto";
import { type FileHandle, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NativeFramePacket } from "../src/core/rendering/native-export-protocol.js";
import { type OwnedNativeFrame, ownNativeFrame } from "./native-export-input.js";

interface StoredResource {
  digest: string;
  length: number;
  offset: number;
}

interface StoredFrame {
  plan: string;
  resources: string[];
}

export interface NativeExportSpoolLimits {
  maxBytes: number;
  maxResources: number;
  maxFrameBytes: number;
  frameCount: number;
}

/** An unpublished, bounded snapshot of the exact frames accepted by whole-job preflight. */
export class NativeExportSpool {
  readonly #directory: string;
  readonly #limits: NativeExportSpoolLimits;
  readonly #pack: FileHandle;
  readonly #resources = new Map<string, StoredResource>();
  readonly #frames: { digest: string; metadataBytes: number; planBytes: number }[] = [];
  #bytes = 0;
  #packBytes = 0;
  #sealed = false;
  #closed = false;
  #pending?: Promise<void>;
  #disposal?: Promise<void>;

  private constructor(directory: string, limits: NativeExportSpoolLimits, pack: FileHandle) {
    this.#directory = directory;
    this.#limits = { ...limits };
    this.#pack = pack;
  }

  static async create(root: string, limits: NativeExportSpoolLimits): Promise<NativeExportSpool> {
    for (const [value, minimum, maximum] of [
      [limits.maxBytes, 32, 32 * 1024 ** 3],
      [limits.maxResources, 1, 262144],
      [limits.maxFrameBytes, 32, 67_108_864],
      [limits.frameCount, 1, 1_000_000],
    ])
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new Error("Invalid native export spool limits");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "aster-native-export-"));
    try {
      return new NativeExportSpool(
        directory,
        limits,
        await open(join(directory, "resources.pack"), "wx+"),
      );
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  get statistics() {
    return {
      frames: this.#frames.length,
      resources: this.#resources.size,
      bytes: this.#bytes,
      sealed: this.#sealed,
    };
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
      frame !== this.#frames.length ||
      frame >= this.#limits.frameCount
    )
      throw new Error("Native preflight frame is out of order or spool is unavailable");
    const owned = ownNativeFrame(input, this.#limits.maxFrameBytes);
    let release!: () => void;
    this.#pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const packets = owned.resources.map((packet) => {
        const encoded = Buffer.concat([packet.control, Buffer.from("\n"), packet.bytes]);
        const digest = createHash("sha256").update(encoded).digest("hex");
        const previous = this.#resources.get(packet.message.hash);
        if (previous && previous.digest !== digest)
          throw new Error("Native resource identity changed during preflight");
        return { hash: packet.message.hash, encoded, digest, previous };
      });
      const record: StoredFrame = {
        plan: createHash("sha256").update(owned.plan).digest("hex"),
        resources: packets.map((packet) => packet.hash),
      };
      const metadata = Buffer.from(JSON.stringify(record));
      const newPackets = packets.filter((packet) => !packet.previous);
      const addedBytes =
        owned.plan.length +
        metadata.length +
        newPackets.reduce((sum, packet) => sum + packet.encoded.length, 0);
      if (
        this.#bytes + addedBytes > this.#limits.maxBytes ||
        this.#resources.size + newPackets.length > this.#limits.maxResources
      )
        throw new Error("Native export spool exceeds its storage budget");
      // Admission finishes before this frame becomes replayable. Failure invalidates the job.
      await admit(owned);
      if (this.#closed) throw new Error("Native preflight was cancelled");
      // Resources share one append-only file; offsets are published only after the bounded write.
      const packed = Buffer.concat(newPackets.map((packet) => packet.encoded));
      let written = 0;
      while (written < packed.length) {
        const result = await this.#pack.write(
          packed,
          written,
          packed.length - written,
          this.#packBytes + written,
        );
        if (!result.bytesWritten) throw new Error("Native spool resource write stalled");
        written += result.bytesWritten;
      }
      await writeFile(join(this.#directory, `${frame}.plan`), owned.plan, { flag: "wx" });
      await writeFile(join(this.#directory, `${frame}.json`), metadata, { flag: "wx" });
      if (this.#closed) throw new Error("Native preflight was cancelled");
      for (const packet of newPackets) {
        this.#resources.set(packet.hash, {
          digest: packet.digest,
          length: packet.encoded.length,
          offset: this.#packBytes,
        });
        this.#packBytes += packet.encoded.length;
      }
      this.#frames.push({
        digest: createHash("sha256").update(metadata).digest("hex"),
        metadataBytes: metadata.length,
        planBytes: owned.plan.length,
      });
      this.#bytes += addedBytes;
    } catch (error) {
      this.#closed = true;
      throw error;
    } finally {
      this.#pending = undefined;
      release();
    }
  }

  seal(): void {
    if (
      this.#closed ||
      this.#pending ||
      this.#sealed ||
      this.#frames.length !== this.#limits.frameCount
    )
      throw new Error("Native preflight has not admitted the complete job");
    this.#sealed = true;
  }

  async read(frame: number): Promise<OwnedNativeFrame> {
    if (
      this.#closed ||
      !this.#sealed ||
      !Number.isSafeInteger(frame) ||
      frame < 0 ||
      frame >= this.#frames.length
    )
      throw new Error("Native replay frame is unavailable");
    if (this.#pending) throw new Error("Native spool already has a pending operation");
    let release!: () => void;
    this.#pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      return await this.#readFrame(frame);
    } catch (error) {
      this.#closed = true;
      throw error;
    } finally {
      this.#pending = undefined;
      release();
    }
  }

  async #readFrame(frame: number): Promise<OwnedNativeFrame> {
    const entry = this.#frames[frame];
    const metadata = await this.#readExact(`${frame}.json`, entry.metadataBytes);
    if (createHash("sha256").update(metadata).digest("hex") !== entry.digest)
      throw new Error("Native spool frame metadata changed");
    const record = JSON.parse(metadata.toString("utf8")) as StoredFrame;
    const plan = await this.#readExact(`${frame}.plan`, entry.planBytes);
    if (createHash("sha256").update(plan).digest("hex") !== record.plan)
      throw new Error("Native spool plan changed");
    const resources: OwnedNativeFrame["resources"] = [];
    const stored = record.resources
      .map((hash) => {
        const resource = this.#resources.get(hash);
        if (!resource) throw new Error("Native spool resource is missing");
        return { hash, ...resource };
      })
      .sort((a, b) => a.offset - b.offset);
    const info = await this.#pack.stat();
    if (!info.isFile() || info.size !== this.#packBytes)
      throw new Error("Native spool resource file size changed");
    const encodedResources = new Map<string, Buffer>();
    for (let first = 0; first < stored.length; ) {
      let last = first + 1;
      let length = stored[first].length;
      while (last < stored.length && stored[last].offset === stored[first].offset + length) {
        length += stored[last++].length;
      }
      const packed = await this.#readRange(this.#pack, stored[first].offset, length);
      for (let index = first; index < last; index++) {
        const expected = stored[index];
        const offset = expected.offset - stored[first].offset;
        encodedResources.set(expected.hash, packed.subarray(offset, offset + expected.length));
      }
      first = last;
    }
    if ((await this.#pack.stat()).size !== this.#packBytes)
      throw new Error("Native spool resource file size changed during read");
    for (const hash of record.resources) {
      const expected = this.#resources.get(hash);
      const encoded = encodedResources.get(hash);
      if (
        !expected ||
        !encoded ||
        encoded.length !== expected.length ||
        createHash("sha256").update(encoded).digest("hex") !== expected.digest
      )
        throw new Error("Native spool resource changed");
      const newline = encoded.indexOf(10);
      const control = encoded.subarray(0, newline);
      resources.push({
        message: JSON.parse(control.toString("utf8")),
        control,
        bytes: encoded.subarray(newline + 1),
      });
    }
    if (this.#closed) throw new Error("Native replay was cancelled");
    return { plan, resources };
  }

  async #readExact(name: string, length: number): Promise<Buffer> {
    const file = await open(join(this.#directory, name), "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== length) throw new Error("Native spool file size changed");
      const bytes = await this.#readRange(file, 0, length);
      if ((await file.read(Buffer.alloc(1), 0, 1, length)).bytesRead)
        throw new Error("Native spool file grew during read");
      return bytes;
    } finally {
      await file.close();
    }
  }

  async #readRange(file: FileHandle, start: number, length: number): Promise<Buffer> {
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = await file.read(bytes, offset, length - offset, start + offset);
      if (!read.bytesRead) throw new Error("Native spool file is truncated");
      offset += read.bytesRead;
    }
    return bytes;
  }

  dispose(): Promise<void> {
    this.#closed = true;
    if (!this.#disposal)
      this.#disposal = (async () => {
        await this.#pending;
        await this.#pack.close();
        await rm(this.#directory, { recursive: true, force: true });
        this.#frames.length = 0;
        this.#resources.clear();
        this.#bytes = 0;
        this.#packBytes = 0;
      })();
    return this.#disposal;
  }
}
