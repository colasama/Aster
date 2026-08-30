/// <reference lib="webworker" />

import { decodeTiffRgba } from "./tiff-decoder";

interface DecodeRequest {
  id: number;
  bytes: ArrayBuffer;
  includePixels: boolean;
}

interface DecodeSuccess {
  id: number;
  ok: true;
  width: number;
  height: number;
  pixels?: ArrayBuffer;
}

interface DecodeFailure {
  id: number;
  ok: false;
  message: string;
}

const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.addEventListener("message", (event: MessageEvent<DecodeRequest>) => {
  const request = event.data;
  try {
    const decoded = decodeTiffRgba(request.bytes);
    if (!request.includePixels) {
      worker.postMessage({
        id: request.id,
        ok: true,
        width: decoded.width,
        height: decoded.height,
      } satisfies DecodeSuccess);
      return;
    }
    const pixels = decoded.pixels.buffer;
    if (!(pixels instanceof ArrayBuffer)) throw new Error("TIFF pixel plane is not transferable");
    worker.postMessage(
      {
        id: request.id,
        ok: true,
        width: decoded.width,
        height: decoded.height,
        pixels,
      } satisfies DecodeSuccess,
      [pixels],
    );
  } catch (error) {
    worker.postMessage({
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    } satisfies DecodeFailure);
  }
});
