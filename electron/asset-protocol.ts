import { pathToFileURL } from "node:url";
import { renderPathKey } from "./render-queue-paths.js";

export const ASSET_SCHEME = "aster-asset";

/**
 * `supportFetchAPI` makes the scheme a Fetch target; `corsEnabled` separately lets Chromium issue
 * the cross-scheme request from Aster's packaged file origin. Both are required for SVG/PSD byte
 * imports that use `fetch(aster-asset://...)` rather than an img/media element.
 */
export const ASSET_SCHEME_REGISTRATION = {
  scheme: ASSET_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
} as const;

export interface AssetProtocolHandlerOptions {
  readonly allowedAssets: ReadonlyMap<string, string>;
  readonly fetchFile: (url: string) => Promise<Response>;
}

export function createAssetProtocolHandler(options: AssetProtocolHandlerOptions) {
  return async (request: Pick<Request, "method" | "url">): Promise<Response> => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD")
        return textResponse("Method not allowed", 405);
      const url = new URL(request.url);
      if (url.protocol !== `${ASSET_SCHEME}:` || url.hostname !== "local")
        return textResponse("Not found", 404);
      const encodedPath = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
      const requestedPath = decodeURIComponent(encodedPath);
      const allowedPath = options.allowedAssets.get(renderPathKey(requestedPath));
      if (!allowedPath) return textResponse("Not found", 404);
      return await options.fetchFile(pathToFileURL(allowedPath).toString());
    } catch {
      return textResponse("Not found", 404);
    }
  };
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
