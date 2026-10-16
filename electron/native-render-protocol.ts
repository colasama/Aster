export interface NativeVideoConfig {
  size: { width: number; height: number };
  frame_rate: { numerator: number; denominator: number };
  bitrate_bps: number;
}

export type NativeSessionCommand =
  | { type: "probe"; adapter_luid: { low: number; high: number } | null; video: NativeVideoConfig }
  | {
      type: "put_resource";
      resource: { hash: string; kind: string; descriptor: unknown };
      payload_bytes: number;
    }
  | { type: "evict_resource"; hash: string }
  | { type: "check_frame"; plan_bytes: number }
  | { type: "warm_frame"; plan_bytes: number }
  | { type: "begin_export"; video: NativeVideoConfig; frame_count: number }
  | { type: "render_frame"; plan_bytes: number; frame_index: number }
  | { type: "finish_export" | "cancel_export" | "shutdown" };

export interface NativePacketMetadata {
  frame_index: number;
  timestamp_100ns: number;
  duration_100ns: number;
  payload_bytes: number;
}

export interface NativeSessionReply {
  version: 1;
  request_id: number;
  payload_bytes: number;
  response: Record<string, unknown> & { type: string };
  payload: Buffer;
}

export type NativeResourceCommand = Extract<
  NativeSessionCommand,
  { type: "put_resource" | "evict_resource" }
>;
export interface NativeResourceRequest {
  command: NativeResourceCommand;
  payload?: Uint8Array;
}

const responseTypes: Record<NativeSessionCommand["type"], string> = {
  probe: "capabilities",
  put_resource: "resource_stored",
  evict_resource: "resource_evicted",
  check_frame: "frame_checked",
  warm_frame: "frame_warmed",
  begin_export: "export_started",
  render_frame: "encoded",
  finish_export: "encoded",
  cancel_export: "export_cancelled",
  shutdown: "closed",
};

export function sessionControl(
  id: number,
  command: NativeSessionCommand,
  payload: Uint8Array,
  controlLimit: number,
  payloadLimit: number,
): Buffer {
  const declared =
    command.type === "put_resource"
      ? command.payload_bytes
      : command.type === "check_frame" ||
          command.type === "render_frame" ||
          command.type === "warm_frame"
        ? command.plan_bytes
        : 0;
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Native request ID exhausted");
  if (declared !== payload.byteLength || declared > payloadLimit)
    throw new Error("Native request payload does not match its bounded declaration");
  const control = Buffer.from(`${JSON.stringify({ version: 1, request_id: id, command })}\n`);
  if (control.length > controlLimit) throw new Error("Native request control exceeds limit");
  return control;
}

/** One response per request; allocate binary storage only after validating its control line. */
export class NativeReplyReader {
  readonly #control: Buffer;
  readonly #payloadLimit: number;
  readonly #id: number;
  readonly #command: NativeSessionCommand;
  #controlUsed = 0;
  #payloadUsed = 0;
  #reply?: NativeSessionReply;
  #complete = false;

  constructor(
    id: number,
    command: NativeSessionCommand,
    controlLimit: number,
    payloadLimit: number,
  ) {
    this.#id = id;
    this.#command = command;
    this.#control = Buffer.alloc(controlLimit);
    this.#payloadLimit = payloadLimit;
  }

  push(chunk: Buffer): NativeSessionReply | undefined {
    if (this.#complete) throw new Error("Native sidecar sent an unsolicited reply");
    if (!this.#reply) {
      const newline = chunk.indexOf(10);
      const length = newline < 0 ? chunk.length : newline + 1;
      if (length > this.#control.length - this.#controlUsed)
        throw new Error("Native reply control exceeds limit");
      chunk.copy(this.#control, this.#controlUsed, 0, length);
      this.#controlUsed += length;
      if (newline < 0) return;
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          this.#control.subarray(0, this.#controlUsed),
        ),
      );
      if (
        value?.version !== 1 ||
        value.request_id !== this.#id ||
        !Number.isSafeInteger(value.payload_bytes) ||
        value.payload_bytes < 0 ||
        value.payload_bytes > this.#payloadLimit ||
        !value.response ||
        typeof value.response !== "object" ||
        Array.isArray(value.response)
      )
        throw new Error("Native reply has an invalid envelope or request identity");
      if (
        value.response.type !== "error" &&
        value.response.type !== responseTypes[this.#command.type]
      )
        throw new Error("Native reply does not match its command");
      if (value.response.type !== "encoded" && value.payload_bytes !== 0)
        throw new Error("Native control reply cannot carry binary output");
      if (value.response.type === "error") {
        if (
          typeof value.response.message !== "string" ||
          typeof value.response.terminal !== "boolean"
        )
          throw new Error("Native error reply is malformed");
        throw new Error(`Native sidecar rejected request: ${value.response.message}`);
      }
      this.#reply = { ...value, payload: Buffer.alloc(value.payload_bytes) };
      chunk = chunk.subarray(length);
    }
    const reply = this.#reply;
    if (!reply) throw new Error("Native response control missing");
    if (chunk.length > reply.payload_bytes - this.#payloadUsed)
      throw new Error("Native reply contains trailing or unsolicited bytes");
    chunk.copy(reply.payload, this.#payloadUsed);
    this.#payloadUsed += chunk.length;
    if (this.#payloadUsed !== reply.payload_bytes) return;
    if (reply.response.type === "encoded") this.#validateEncoded(reply);
    this.#complete = true;
    return reply;
  }

  #validateEncoded(reply: NativeSessionReply): void {
    const { packets, complete, submitted_frame } = reply.response;
    const expectedFrame = this.#command.type === "render_frame" ? this.#command.frame_index : null;
    if (
      !Array.isArray(packets) ||
      submitted_frame !== expectedFrame ||
      complete !== (this.#command.type === "finish_export")
    )
      throw new Error("Native encoded reply has invalid completion or frame identity");
    let offset = 0;
    for (const packet of packets) {
      if (
        !packet ||
        !Number.isSafeInteger(packet.frame_index) ||
        packet.frame_index < 0 ||
        !Number.isSafeInteger(packet.timestamp_100ns) ||
        packet.timestamp_100ns < 0 ||
        !Number.isSafeInteger(packet.duration_100ns) ||
        packet.duration_100ns <= 0 ||
        !Number.isSafeInteger(packet.payload_bytes) ||
        packet.payload_bytes < 5 ||
        packet.payload_bytes > reply.payload_bytes - offset
      )
        throw new Error("Native encoded packet metadata exceeds bounds");
      const bytes = reply.payload.subarray(offset, offset + packet.payload_bytes);
      if (
        !(
          bytes[0] === 0 &&
          bytes[1] === 0 &&
          (bytes[2] === 1 || (bytes[2] === 0 && bytes[3] === 1))
        )
      )
        throw new Error("Native encoded packet is not Annex-B");
      offset += packet.payload_bytes;
    }
    if (offset !== reply.payload_bytes)
      throw new Error("Native encoded packet lengths do not match");
  }
}

/** Resource acknowledgements have no binary payload; retain only one bounded line at a time. */
export class NativeResourceReplyReader {
  readonly #commands: readonly NativeResourceCommand[];
  readonly #firstId: number;
  readonly #controlLimit: number;
  #index = 0;
  #reader: NativeReplyReader;

  constructor(firstId: number, commands: readonly NativeResourceCommand[], controlLimit: number) {
    if (commands.length < 1 || commands.length > 64)
      throw new Error("Native resource batch exceeds count limit");
    this.#firstId = firstId;
    this.#commands = commands;
    this.#controlLimit = controlLimit;
    this.#reader = new NativeReplyReader(firstId, commands[0], controlLimit, 0);
  }

  push(chunk: Buffer): NativeSessionReply | undefined {
    while (chunk.length) {
      if (this.#index === this.#commands.length)
        throw new Error("Native resource batch sent an unsolicited reply");
      const newline = chunk.indexOf(10);
      const length = newline < 0 ? chunk.length : newline + 1;
      const reply = this.#reader.push(chunk.subarray(0, length));
      chunk = chunk.subarray(length);
      if (!reply) continue;
      this.#index++;
      if (this.#index === this.#commands.length) {
        if (chunk.length) throw new Error("Native resource batch contains trailing replies");
        return reply;
      }
      this.#reader = new NativeReplyReader(
        this.#firstId + this.#index,
        this.#commands[this.#index],
        this.#controlLimit,
        0,
      );
    }
    return undefined;
  }
}
