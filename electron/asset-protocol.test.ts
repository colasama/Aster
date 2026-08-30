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

    expect(result).toBe(response);
    expect(result.ok).toBe(true);
    expect(result.headers.get("content-type")).toBe("image/svg+xml");
    expect(fetchFile).toHaveBeenCalledWith(pathToFileURL(path).toString());
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
