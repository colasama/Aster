export function mediaBytesIdentity(bytes: Uint8Array): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (const byte of bytes) {
    left = Math.imul(left ^ byte, 0x01000193);
    right = Math.imul(right ^ byte, 0x85ebca6b);
  }
  return `fnv64:${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
    .toString(16)
    .padStart(8, "0")}:${bytes.byteLength}`;
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
