export function mediaBytesIdentity(bytes: Uint8Array): string {
  return new MediaBytesIdentity().update(bytes).digest();
}

/** The same persisted byte identity for buffers and bounded streaming file copies. */
export class MediaBytesIdentity {
  #left = 0x811c9dc5;
  #right = 0x9e3779b9;
  #bytes = 0;

  update(bytes: Uint8Array): this {
    this.#bytes += bytes.byteLength;
    if (!Number.isSafeInteger(this.#bytes)) throw new Error("Media identity byte count overflow");
    for (const byte of bytes) {
      this.#left = Math.imul(this.#left ^ byte, 0x01000193);
      this.#right = Math.imul(this.#right ^ byte, 0x85ebca6b);
    }
    return this;
  }

  digest(): string {
    return `fnv64:${(this.#left >>> 0).toString(16).padStart(8, "0")}${(this.#right >>> 0)
      .toString(16)
      .padStart(8, "0")}:${this.#bytes}`;
  }
}

export function mediaTextIdentity(value: string): string {
  return mediaBytesIdentity(new TextEncoder().encode(value));
}

export function mediaIdentityByteLength(value: string, path = "media identity"): number {
  const match = /^fnv64:[0-9a-f]{16}:(\d+)$/.exec(value);
  if (!match) throw new Error(`${path} is not a supported byte identity`);
  const bytes = Number(match[1]);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`${path} has an invalid length`);
  return bytes;
}
