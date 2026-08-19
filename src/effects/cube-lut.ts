import type { Lut3dResource } from "../core/types";

const MAX_CUBE_BYTES = 4 * 1024 * 1024;
const MAX_LUT_SIZE = 64;
const MAX_CHANNEL_VALUE = 64;

export async function parseCubeLutFile(file: File): Promise<Lut3dResource> {
  if (file.size > MAX_CUBE_BYTES) throw new Error("LUT files must be 4 MiB or smaller");
  return parseCubeLut(await file.text(), file.name);
}

export function parseCubeLut(source: string, name = "Imported.cube"): Lut3dResource {
  if (new TextEncoder().encode(source).byteLength > MAX_CUBE_BYTES)
    throw new Error("LUT files must be 4 MiB or smaller");
  let size = 0;
  let title: string | undefined;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const data: number[] = [];

  for (const [lineIndex, original] of source.split(/\r?\n/).entries()) {
    const line = original.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [directive] = line.split(/\s+/, 1);
    if (directive === "TITLE") {
      const match = /^TITLE\s+"([^"]{1,160})"$/.exec(line);
      if (!match) throw new Error(`Invalid TITLE on line ${lineIndex + 1}`);
      title = match[1];
    } else if (directive === "LUT_3D_SIZE") {
      size = Number.parseInt(line.slice(directive.length).trim(), 10);
      if (!Number.isInteger(size) || size < 2 || size > MAX_LUT_SIZE)
        throw new Error(`LUT_3D_SIZE must be between 2 and ${MAX_LUT_SIZE}`);
    } else if (directive === "DOMAIN_MIN") {
      domainMin = parseTriplet(line.slice(directive.length), lineIndex);
    } else if (directive === "DOMAIN_MAX") {
      domainMax = parseTriplet(line.slice(directive.length), lineIndex);
    } else if (/^[A-Z][A-Z0-9_]*$/.test(directive)) {
      throw new Error(`Unsupported .cube directive ${directive}`);
    } else {
      data.push(...parseTriplet(line, lineIndex));
    }
  }

  if (!size) throw new Error("LUT_3D_SIZE is required");
  if (data.length !== size ** 3 * 3)
    throw new Error(`Expected ${size ** 3} LUT rows, received ${data.length / 3}`);
  for (let channel = 0; channel < 3; channel += 1) {
    if (domainMax[channel] <= domainMin[channel])
      throw new Error("DOMAIN_MAX must be greater than DOMAIN_MIN on every channel");
  }
  return {
    kind: "lut3d",
    name: name.slice(0, 160) || "Imported.cube",
    title,
    size,
    data,
    domainMin,
    domainMax,
    checksum: fnv1a(source),
  };
}

function parseTriplet(value: string, lineIndex: number): [number, number, number] {
  const channels = value.trim().split(/\s+/).map(Number);
  if (
    channels.length !== 3 ||
    channels.some((channel) => !Number.isFinite(channel) || Math.abs(channel) > MAX_CHANNEL_VALUE)
  )
    throw new Error(`Expected three finite channels on line ${lineIndex + 1}`);
  return channels as [number, number, number];
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
