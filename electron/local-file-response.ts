import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { mediaMimeType } from "./reference-media.js";

/** Called only after the asset protocol has resolved an authorized path. */
export async function fetchLocalAsset(url: string, init: RequestInit): Promise<Response> {
  const path = fileURLToPath(url);
  const info = await stat(path);
  if (!info.isFile()) return new Response(null, { status: 404 });
  const headers = new Headers({
    "content-type": mediaMimeType(path),
    "content-length": String(info.size),
    "accept-ranges": "bytes",
    "last-modified": info.mtime.toUTCString(),
  });
  const requested = new Headers(init.headers);
  let range = requested.get("range");
  const ifRange = requested.get("if-range");
  if (
    ifRange &&
    (!Number.isFinite(Date.parse(ifRange)) || info.mtimeMs >= Date.parse(ifRange) + 1000)
  )
    range = null;
  let start = 0;
  let end = info.size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
    } else start = Number.NaN;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= info.size
    ) {
      headers.set("content-range", `bytes */${info.size}`);
      headers.set("content-length", "0");
      return new Response(null, { status: 416, headers });
    }
    headers.set("content-range", `bytes ${start}-${end}/${info.size}`);
    headers.set("content-length", String(end - start + 1));
  }
  const body =
    init.method === "HEAD" || info.size === 0
      ? null
      : (Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>);
  return new Response(body, { status: range ? 206 : 200, headers });
}
