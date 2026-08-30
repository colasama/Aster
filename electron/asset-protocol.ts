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
  readonly fetchFile: (url: string, init: RequestInit) => Promise<Response>;
}

export function createAssetProtocolHandler(options: AssetProtocolHandlerOptions) {
  return async (
    request: Pick<Request, "method" | "url"> & Partial<Pick<Request, "headers">>,
  ): Promise<Response> => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS")
        return textResponse("Method not allowed", 405);
      const url = new URL(request.url);
      if (url.protocol !== `${ASSET_SCHEME}:` || url.hostname !== "local")
        return textResponse("Not found", 404);
      const encodedPath = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
      const requestedPath = decodeURIComponent(encodedPath);
      const allowedPath = options.allowedAssets.get(renderPathKey(requestedPath));
      if (!allowedPath) return textResponse("Not found", 404);
      if (request.method === "OPTIONS") return corsPreflightResponse();
      const headers = forwardedMediaHeaders(request.headers);
      const response = await options.fetchFile(pathToFileURL(allowedPath).toString(), {
        method: request.method,
        ...(headers ? { headers } : {}),
      });
      return assetResponse(response, request.method);
    } catch {
      return textResponse("Not found", 404);
    }
  };
}

function forwardedMediaHeaders(requestHeaders?: Headers): Headers | undefined {
  const headers = new Headers();
  let forwarded = false;
  for (const name of ["range", "if-range"] as const) {
    const value = requestHeaders?.get(name);
    if (value) {
      headers.set(name, value);
      forwarded = true;
    }
  }
  return forwarded ? headers : undefined;
}

function assetResponse(response: Response, method: string): Response {
  const headers = new Headers(response.headers);
  setCorsHeaders(headers);
  headers.set("access-control-expose-headers", "Accept-Ranges, Content-Length, Content-Range");
  return new Response(method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsPreflightResponse(): Response {
  const headers = new Headers();
  setCorsHeaders(headers);
  headers.set("access-control-allow-headers", "Range, If-Range");
  headers.set("access-control-max-age", "86400");
  return new Response(null, { status: 204, headers });
}

function setCorsHeaders(headers: Headers): void {
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
}

function textResponse(body: string, status: number): Response {
  const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
  setCorsHeaders(headers);
  return new Response(body, { status, headers });
}
