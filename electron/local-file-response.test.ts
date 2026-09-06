import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fetchLocalAsset } from "./local-file-response";

let directory: string;
let url: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aster-range-"));
  const path = join(directory, "video.mp4");
  await writeFile(
    path,
    Uint8Array.from({ length: 100 }, (_, i) => i),
  );
  url = pathToFileURL(path).href;
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
it("streams full responses with the size Chromium needs for seeking", async () => {
  const response = await fetchLocalAsset(url, { method: "GET" });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-length")).toBe("100");
  expect(response.headers.get("accept-ranges")).toBe("bytes");
  expect((await response.arrayBuffer()).byteLength).toBe(100);
});
it.each([
  ["bytes=10-12", 10, 12],
  ["bytes=90-", 90, 99],
  ["bytes=-3", 97, 99],
  ["bytes=97-1000", 97, 99],
])("serves %s with exact 206 metadata and bytes", async (range, start, end) => {
  const response = await fetchLocalAsset(url, { method: "GET", headers: { range: String(range) } });
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/100`);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    Uint8Array.from({ length: Number(end) - Number(start) + 1 }, (_, i) => Number(start) + i),
  );
});
it.each(["bytes=100-", "bytes=4-2", "bytes=-0", "bytes=0-1,3-4", "bytes=-", "bytes=oops"])(
  "rejects unsatisfiable or unsupported range %s",
  async (range) => {
    const response = await fetchLocalAsset(url, { method: "GET", headers: { range } });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */100");
  },
);
it("serves HEAD without a stream and ignores a stale If-Range", async () => {
  const head = await fetchLocalAsset(url, { method: "HEAD" });
  expect(head.body).toBeNull();
  expect(head.headers.get("content-length")).toBe("100");
  const stale = await fetchLocalAsset(url, {
    method: "GET",
    headers: { range: "bytes=1-2", "if-range": "Thu, 01 Jan 1970 00:00:00 GMT" },
  });
  expect(stale.status).toBe(200);
  expect((await stale.arrayBuffer()).byteLength).toBe(100);
});
