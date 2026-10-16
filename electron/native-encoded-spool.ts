import { createHash } from "node:crypto";
import { type FileHandle, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  NativeReplyReader,
  type NativeSessionReply,
  type NativeVideoConfig,
} from "./native-render-protocol.js";

interface EncodedEntry {
  offset: number;
  length: number;
  requestId: number;
  digest: string;
}

/** Private compressed packets are replayable only after every input and the hardware drain succeed. */
export class NativeEncodedSpool {
  readonly #directory: string;
  readonly #file: FileHandle;
  readonly #frames: number;
  readonly #video: NativeVideoConfig;
  readonly #maxBytes: number;
  readonly #entries: EncodedEntry[] = [];
  #bytes = 0;
  #encoded = 0;
  #sealed = false;
  #closed = false;
  #pending?: Promise<unknown>;
  #disposal?: Promise<void>;

  private constructor(
    directory: string,
    file: FileHandle,
    frames: number,
    video: NativeVideoConfig,
    maxBytes: number,
  ) {
    this.#directory = directory;
    this.#file = file;
    this.#frames = frames;
    this.#video = structuredClone(video);
    this.#maxBytes = maxBytes;
  }

  static async create(
    root: string,
    frames: number,
    video: NativeVideoConfig,
    maxBytes = 1024 ** 3,
  ): Promise<NativeEncodedSpool> {
    if (
      !Number.isSafeInteger(frames) ||
      frames < 1 ||
      frames > 1_000_000 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 1024 ** 3 ||
      !Number.isSafeInteger(video.frame_rate.numerator) ||
      video.frame_rate.numerator < 1 ||
      !Number.isSafeInteger(video.frame_rate.denominator) ||
      video.frame_rate.denominator < 1
    )
      throw new Error("Invalid compressed spool limits or frame clock");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "aster-native-encoded-"));
    try {
      return new NativeEncodedSpool(
        directory,
        await open(join(directory, "packets.bin"), "wx+"),
        frames,
        video,
        maxBytes,
      );
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  get statistics() {
    return {
      frames: Math.min(this.#entries.length, this.#frames),
      packets: this.#encoded,
      bytes: this.#bytes,
      sealed: this.#sealed,
    };
  }

  async append(frame: number, reply: NativeSessionReply): Promise<void> {
    await this.#run(async () => {
      if (this.#sealed || frame !== this.#entries.length || frame < 0 || frame >= this.#frames)
        throw new Error("Compressed spool input is out of order");
      await this.#append(reply, frame);
    });
  }

  async seal(reply: NativeSessionReply): Promise<void> {
    await this.#run(async () => {
      if (this.#sealed || this.#entries.length !== this.#frames)
        throw new Error("Compressed spool has not admitted every frame");
      await this.#append(reply, null);
      const encoder = reply.response.encoder as Record<string, unknown> | undefined;
      if (
        this.#encoded !== this.#frames ||
        encoder?.drain_completed !== true ||
        encoder.accepted_frames !== this.#frames ||
        encoder.encoded_frames !== this.#frames ||
        encoder.cancelled !== false
      )
        throw new Error("Compressed spool encoder did not drain every frame");
      this.#sealed = true;
    });
  }

  async #append(reply: NativeSessionReply, frame: number | null): Promise<void> {
    if (reply.payload.length > 67_108_864)
      throw new Error("Compressed reply exceeds payload limit");
    const { payload, ...control } = reply;
    const line = Buffer.from(`${JSON.stringify(control)}\n`);
    if (line.length > 65_536) throw new Error("Compressed reply exceeds control limit");
    const bytes = Buffer.concat([line, payload]);
    if (bytes.length > this.#maxBytes - this.#bytes)
      throw new Error("Compressed spool exceeds storage budget");
    const checked = this.#decode(bytes, reply.request_id, frame);
    const packets = checked.response.packets as {
      frame_index: number;
      timestamp_100ns: number;
      duration_100ns: number;
    }[];
    const ticks = BigInt(this.#video.frame_rate.denominator) * 10_000_000n;
    const rate = BigInt(this.#video.frame_rate.numerator);
    const submitted = frame === null ? this.#frames : frame + 1;
    for (const [index, packet] of packets.entries()) {
      const expected = this.#encoded + index;
      const timestamp = (BigInt(expected) * ticks) / rate;
      if (
        packet.frame_index !== expected ||
        expected >= submitted ||
        BigInt(packet.timestamp_100ns) !== timestamp ||
        BigInt(packet.duration_100ns) !== (BigInt(expected + 1) * ticks) / rate - timestamp
      )
        throw new Error("Compressed packet clock or order differs from the admitted job");
    }
    let written = 0;
    while (written < bytes.length) {
      const result = await this.#file.write(
        bytes,
        written,
        bytes.length - written,
        this.#bytes + written,
      );
      if (!result.bytesWritten) throw new Error("Compressed spool write stalled");
      written += result.bytesWritten;
    }
    if (this.#closed) throw new Error("Compressed spool was cancelled");
    this.#entries.push({
      offset: this.#bytes,
      length: bytes.length,
      requestId: reply.request_id,
      digest: createHash("sha256").update(bytes).digest("hex"),
    });
    this.#bytes += bytes.length;
    this.#encoded += packets.length;
  }

  /** The final entry is the hardware drain; callers replay it immediately after the last input. */
  async read(frame: number): Promise<NativeSessionReply> {
    return this.#run(async () => {
      if (!this.#sealed || !Number.isSafeInteger(frame) || frame < 0 || frame > this.#frames)
        throw new Error("Compressed spool is not ready for replay");
      const entry = this.#entries[frame];
      if ((await this.#file.stat()).size !== this.#bytes)
        throw new Error("Compressed spool size changed");
      const bytes = Buffer.alloc(entry.length);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await this.#file.read(
          bytes,
          offset,
          bytes.length - offset,
          entry.offset + offset,
        );
        if (!result.bytesRead) throw new Error("Compressed spool is truncated");
        offset += result.bytesRead;
      }
      if (this.#closed || createHash("sha256").update(bytes).digest("hex") !== entry.digest)
        throw new Error("Compressed spool changed or was cancelled");
      return this.#decode(bytes, entry.requestId, frame === this.#frames ? null : frame);
    });
  }

  #decode(bytes: Buffer, id: number, frame: number | null): NativeSessionReply {
    const reader = new NativeReplyReader(
      id,
      frame === null
        ? { type: "finish_export" }
        : { type: "render_frame", frame_index: frame, plan_bytes: 0 },
      65_536,
      67_108_864,
    );
    const reply = reader.push(bytes);
    if (!reply) throw new Error("Compressed spool record is incomplete");
    return reply;
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#pending) throw new Error("Compressed spool is closed or busy");
    const pending = operation();
    this.#pending = pending;
    try {
      return await pending;
    } catch (error) {
      this.#closed = true;
      throw error;
    } finally {
      this.#pending = undefined;
    }
  }

  dispose(): Promise<void> {
    this.#closed = true;
    this.#disposal ??= (async () => {
      await this.#pending?.catch(() => undefined);
      await this.#file.close();
      await rm(this.#directory, { recursive: true, force: true });
      this.#entries.length = 0;
    })();
    return this.#disposal;
  }
}
