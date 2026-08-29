export interface ParsedSvgSource {
  width: number;
  height: number;
  viewBox: readonly [number, number, number, number];
  sanitized: string;
  dataUrl: string;
  nodeCount: number;
}

const MAX_SVG_BYTES = 16 * 1024 * 1024;
const MAX_SVG_NODES = 100_000;
const MAX_SVG_DIMENSION = 32_768;
const BLOCKED_ELEMENTS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
]);
const URL_ATTRIBUTES = new Set(["href", "xlink:href", "src"]);

/** Parses a self-contained SVG while rejecting active or externally fetched content. */
export function parseSvgSource(source: string): ParsedSvgSource {
  if (!source.trim() || new TextEncoder().encode(source).byteLength > MAX_SVG_BYTES)
    throw new Error("SVG source is empty or exceeds 16 MiB");
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  if (document.querySelector("parsererror")) throw new Error("SVG XML is malformed");
  const root = document.documentElement;
  if (root.localName.toLowerCase() !== "svg") throw new Error("Document root is not SVG");
  const elements = [root, ...document.querySelectorAll("*")];
  if (elements.length > MAX_SVG_NODES)
    throw new Error("SVG node count exceeds the supported limit");
  for (const element of elements) validateElement(element);
  const viewBox = parseViewBox(root.getAttribute("viewBox"));
  const width = dimension(root.getAttribute("width"), viewBox?.[2], "width");
  const height = dimension(root.getAttribute("height"), viewBox?.[3], "height");
  const normalizedViewBox = viewBox ?? ([0, 0, width, height] as const);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.setAttribute("viewBox", normalizedViewBox.join(" "));
  const sanitized = new XMLSerializer().serializeToString(document);
  return {
    width,
    height,
    viewBox: normalizedViewBox,
    sanitized,
    dataUrl: `data:image/svg+xml;base64,${utf8Base64(sanitized)}`,
    nodeCount: elements.length,
  };
}

function validateElement(element: Element): void {
  const name = element.localName.toLowerCase();
  if (BLOCKED_ELEMENTS.has(name)) throw new Error(`SVG element <${name}> is not allowed`);
  for (const attribute of [...element.attributes]) {
    const attributeName = attribute.name.toLowerCase();
    const value = attribute.value.trim();
    if (attributeName.startsWith("on"))
      throw new Error(`SVG event attribute ${attribute.name} is not allowed`);
    if (URL_ATTRIBUTES.has(attributeName) && !safeEmbeddedReference(value))
      throw new Error(`SVG external reference ${attribute.name} is not allowed`);
    if (
      (attributeName === "style" || attributeName === "filter" || attributeName === "fill") &&
      unsafeCss(value)
    )
      throw new Error(`SVG attribute ${attribute.name} contains an unsafe URL`);
  }
  if (name === "style" && unsafeCss(element.textContent ?? ""))
    throw new Error("SVG stylesheet contains an unsafe URL");
}

function safeEmbeddedReference(value: string): boolean {
  if (!value) return true;
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  return normalized.startsWith("#") || normalized.startsWith("data:image/");
}

function unsafeCss(value: string): boolean {
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  if (normalized.includes("@import") || normalized.includes("javascript:")) return true;
  for (const match of normalized.matchAll(/url\(([^)]*)\)/g)) {
    const url = (match[1] ?? "").replace(/["']/g, "");
    if (!safeEmbeddedReference(url)) return true;
  }
  return false;
}

function parseViewBox(value: string | null): readonly [number, number, number, number] | undefined {
  if (!value) return undefined;
  const entries = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    entries.length !== 4 ||
    entries.some((entry) => !Number.isFinite(entry)) ||
    (entries[2] ?? 0) <= 0 ||
    (entries[3] ?? 0) <= 0
  )
    throw new Error("SVG viewBox is invalid");
  return entries as [number, number, number, number];
}

function dimension(value: string | null, fallback: number | undefined, name: string): number {
  const parsed = value ? cssLengthInPixels(value) : undefined;
  const selected = parsed ?? fallback;
  if (!Number.isFinite(selected) || (selected ?? 0) <= 0 || (selected ?? 0) > MAX_SVG_DIMENSION)
    throw new Error(`SVG ${name} is missing or exceeds ${MAX_SVG_DIMENSION} pixels`);
  return selected as number;
}

function cssLengthInPixels(value: string): number | undefined {
  const match = /^([+]?(?:\d+\.?\d*|\.\d+))(px|pt|pc|mm|cm|in)?$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const scale =
    {
      px: 1,
      pt: 96 / 72,
      pc: 16,
      mm: 96 / 25.4,
      cm: 96 / 2.54,
      in: 96,
    }[match[2]?.toLowerCase() ?? "px"] ?? 1;
  return amount * scale;
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
