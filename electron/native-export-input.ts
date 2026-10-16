import type {
  NativeFramePacket,
  NativeResourcePacket,
} from "../src/core/rendering/native-export-protocol.js";
import { copyWireValue } from "../src/core/rendering/wire-copy.js";

export interface OwnedNativeResource {
  message: NativeResourcePacket["message"];
  control: Buffer;
  bytes: Buffer;
  /** Logical payload size when the verified bytes remain in the native resource window. */
  retainedBytes?: number;
}

export interface OwnedNativeFrame {
  plan: Buffer;
  resources: OwnedNativeResource[];
}

/** Bound an IPC frame before copying it; semantic/hash validation is performed by Rust admission. */
export function ownNativeFrame(
  value: NativeFramePacket,
  maximumBytes = 67_108_864,
  retained?: ReadonlyMap<string, OwnedNativeResource>,
): OwnedNativeFrame {
  if (
    !value ||
    !(value.plan instanceof ArrayBuffer) ||
    value.plan.byteLength < 32 ||
    !Array.isArray(value.resources) ||
    value.resources.length > 65_536
  )
    throw new Error("Native frame input is malformed");
  const references = value.retainedResources === undefined ? [] : value.retainedResources;
  if (!Array.isArray(references) || references.length + value.resources.length > 65_536)
    throw new Error("Native retained resource references exceed their limit");
  let total = value.plan.byteLength;
  if (total > maximumBytes) throw new Error("Native frame input exceeds its byte limit");
  const hashes = new Set<string>();
  const resources = value.resources.map((packet) => {
    if (
      !packet ||
      !(packet.bytes instanceof ArrayBuffer) ||
      !packet.message ||
      packet.message.type !== "put_resource" ||
      !/^[a-f0-9]{64}$/.test(packet.message.hash) ||
      ![
        "buffer",
        "media_source",
        "media_frame",
        "raster_pixels",
        "texture_pixels",
        "encoded_texture",
      ].includes(packet.message.kind) ||
      hashes.has(packet.message.hash)
    )
      throw new Error("Native resource input is malformed or duplicated");
    hashes.add(packet.message.hash);
    const control = Buffer.from(canonicalNativeMetadata(packet.message));
    total += control.length + packet.bytes.byteLength;
    if (control.length > 60_000 || total > maximumBytes)
      throw new Error("Native frame resources exceed their byte limit");
    return { packet, control };
  });
  const reused = references.map((hash) => {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || hashes.has(hash))
      throw new Error("Native retained resource reference is malformed or duplicated");
    hashes.add(hash);
    const resource = retained?.get(hash);
    if (!resource) throw new Error("Native retained resource is not in the accepted frame window");
    const retainedBytes = resource.retainedBytes ?? resource.bytes.length;
    total += resource.control.length + retainedBytes;
    if (total > maximumBytes)
      throw new Error("Native retained resources exceed the logical frame byte limit");
    return {
      message: copyWireValue(resource.message),
      control: Buffer.from(resource.control),
      bytes: Buffer.alloc(0),
      retainedBytes,
    };
  });
  return {
    plan: Buffer.from(new Uint8Array(value.plan)),
    resources: [
      ...resources.map(({ packet, control }) => ({
        message: JSON.parse(control.toString("utf8")),
        control,
        bytes: Buffer.from(new Uint8Array(packet.bytes)),
      })),
      ...reused,
    ],
  };
}

/** Stable metadata identities let repeated packets share storage regardless of object key order. */
export function canonicalNativeMetadata(value: unknown): string {
  let remaining = 60_000;
  const token = (text: string) => {
    remaining -= Buffer.byteLength(text);
    if (remaining < 0) throw new Error("Native metadata exceeds control byte limit");
    return text;
  };
  const visit = (entry: unknown, depth: number): string => {
    if (depth > 32) throw new Error("Native metadata nesting exceeds limit");
    if (typeof entry === "string") {
      if (entry.length > 60_000) throw new Error("Native metadata string exceeds limit");
      return token(JSON.stringify(entry));
    }
    if (entry === null || typeof entry === "boolean") return token(JSON.stringify(entry));
    if (typeof entry === "number" && Number.isSafeInteger(entry) && !Object.is(entry, -0))
      return token(String(entry));
    if (Array.isArray(entry)) {
      if (entry.length > 4096) throw new Error("Native metadata array exceeds limit");
      token(`[]${",".repeat(Math.max(0, entry.length - 1))}`);
      return `[${entry.map((item) => visit(item, depth + 1)).join(",")}]`;
    }
    if (
      !entry ||
      typeof entry !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(entry))
    )
      throw new Error("Native metadata must contain JSON values");
    const keys = Object.keys(entry).sort();
    if (keys.length > 256) throw new Error("Native metadata object exceeds limit");
    token(`{}${",".repeat(Math.max(0, keys.length - 1))}`);
    return `{${keys
      .map((key) => {
        if (!/^[\x20-\x7e]{1,128}$/.test(key)) throw new Error("Native metadata key is invalid");
        return `${token(`${JSON.stringify(key)}:`)}${visit((entry as Record<string, unknown>)[key], depth + 1)}`;
      })
      .join(",")}}`;
  };
  return visit(value, 0);
}
