import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ASSET_SCHEME_REGISTRATION, createAssetProtocolHandler } from "./asset-protocol";
import { renderPathKey } from "./render-queue-paths";

describe("packaged asset protocol", () => {
  it("registers both Fetch API and CORS privileges for packaged file-origin imports", () => {
    expect(ASSET_SCHEME_REGISTRATION).toEqual({
      scheme: "aster-asset",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    });
  });

  it("fetches an encoded authorized SVG and preserves its response metadata", async () => {
    const path = resolve("fixtures/aster e2e/图形.svg");
    const response = new Response('<svg xmlns="http://www.w3.org/2000/svg" />', {
      headers: { "content-type": "image/svg+xml" },
    });
    const fetchFile = vi.fn(async () => response);
    const handler = createAssetProtocolHandler({
      allowedAssets: new Map([[renderPathKey(path), path]]),
      fetchFile,
    });

    const result = await handler({
      method: "GET",
      url: `aster-asset://local/${encodeURIComponent(path)}`,
    });

    expect(result).not.toBe(response);
    expect(result.ok).toBe(true);
    expect(result.headers.get("content-type")).toBe("image/svg+xml");
    expect(result.headers.get("access-control-allow-origin")).toBe("*");
    await expect(result.text()).resolves.toContain("<svg");
    expect(fetchFile).toHaveBeenCalledWith(pathToFileURL(path).toString(), { method: "GET" });
  });

  it("keeps media range responses streaming and origin-clean without forwarding credentials", async () => {
    const path = resolve("fixtures/video.mp4");
    const fetchFile = vi.fn(
      async () =>
        new Response(Uint8Array.of(1, 2, 3), {
          status: 206,
          headers: {
            "accept-ranges": "bytes",
            "content-range": "bytes 10-12/100",
            "content-type": "video/mp4",
          },
        }),
    );
    const handler = createAssetProtocolHandler({
      allowedAssets: new Map([[renderPathKey(path), path]]),
      fetchFile,
    });

    const result = await handler({
      method: "GET",
      url: `aster-asset://local/${encodeURIComponent(path)}`,
      headers: new Headers({
        authorization: "must-not-leave-the-renderer",
        origin: "file://",
        range: "bytes=10-12",
      }),
    });

    expect(result.status).toBe(206);
    expect(result.headers.get("content-range")).toBe("bytes 10-12/100");
    expect(result.headers.get("access-control-allow-origin")).toBe("*");
    await expect(result.arrayBuffer()).resolves.toEqual(Uint8Array.of(1, 2, 3).buffer);
    const init = fetchFile.mock.calls[0]?.[1];
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("range")).toBe("bytes=10-12");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(new Headers(init?.headers).has("origin")).toBe(false);
  });

  it("returns an empty CORS-enabled HEAD response", async () => {
    const path = resolve("fixtures/video.mp4");
    const fetchFile = vi.fn(
      async () => new Response(null, { headers: { "content-length": "100" } }),
    );
    const handler = createAssetProtocolHandler({
      allowedAssets: new Map([[renderPathKey(path), path]]),
      fetchFile,
    });

    const result = await handler({
      method: "HEAD",
      url: `aster-asset://local/${encodeURIComponent(path)}`,
    });

    expect(result.body).toBeNull();
    expect(result.headers.get("content-length")).toBe("100");
    expect(result.headers.get("access-control-allow-origin")).toBe("*");
    expect(fetchFile).toHaveBeenCalledWith(pathToFileURL(path).toString(), { method: "HEAD" });
  });

  it("answers authorized media preflights without opening the file", async () => {
    const path = resolve("fixtures/video.mp4");
    const fetchFile = vi.fn(async () => new Response());
    const handler = createAssetProtocolHandler({
      allowedAssets: new Map([[renderPathKey(path), path]]),
      fetchFile,
    });

    const result = await handler({
      method: "OPTIONS",
      url: `aster-asset://local/${encodeURIComponent(path)}`,
    });

    expect(result.status).toBe(204);
    expect(result.headers.get("access-control-allow-origin")).toBe("*");
    expect(result.headers.get("access-control-allow-methods")).toContain("OPTIONS");
    expect(result.headers.get("access-control-allow-headers")).toBe("Range, If-Range");
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it("does not expose unapproved paths, foreign hosts, malformed URLs, or write methods", async () => {
    const fetchFile = vi.fn(async () => new Response("secret"));
    const handler = createAssetProtocolHandler({ allowedAssets: new Map(), fetchFile });
    const requests = [
      { method: "GET", url: `aster-asset://local/${encodeURIComponent(resolve("secret.svg"))}` },
      { method: "GET", url: "aster-asset://foreign/file.svg" },
      { method: "GET", url: "aster-asset://local/%E0%A4%A" },
      { method: "POST", url: "aster-asset://local/file.svg" },
    ];

    const responses = await Promise.all(requests.map((request) => handler(request)));

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 405]);
    expect(fetchFile).not.toHaveBeenCalled();
  });
});
