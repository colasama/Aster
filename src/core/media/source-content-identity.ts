export function sourceContentIdentity(value: {
  mimeType: string;
  dataUrl?: string;
  relativePath?: string;
  runtimeUrl?: string;
  width?: number;
  height?: number;
  duration?: number;
}): string {
  const locator = value.dataUrl ?? value.relativePath ?? value.runtimeUrl ?? "missing";
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  let length = 0;
  for (const part of [
    value.mimeType,
    locator,
    String(value.width ?? 0),
    String(value.height ?? 0),
    String(value.duration ?? 0),
  ]) {
    for (let index = 0; index <= part.length; index += 1) {
      const code = index === part.length ? 0 : part.charCodeAt(index);
      left = Math.imul(left ^ code, 0x01000193);
      right = Math.imul(right ^ code, 0x85ebca6b);
      length += 1;
    }
  }
  return `fnv64:${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
    .toString(16)
    .padStart(8, "0")}:${length}`;
}
