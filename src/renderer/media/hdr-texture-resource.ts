import type { RadianceHdrCpuResult } from "../../core/scheduling/cpu-task-protocol";
import { requirePlan } from "../frame-plan/canonical";
import { contentResourceHashSync } from "../frame-plan/resources";
import { validateTexturePixels } from "../frame-plan/texture-pixels";
import type { PutResource } from "../frame-plan/types";

/** Remove worker row padding while preserving every binary16 channel bit. */
export function prepareHdrTexture(decoded: RadianceHdrCpuResult) {
  const descriptor = validateTexturePixels({
    dimension: "2d",
    width: decoded.width,
    height: decoded.height,
    depth: 1,
    format: "rgba16float",
  });
  const { pixels, bytesPerRow, width, height } = decoded;
  requirePlan(
    pixels instanceof Uint16Array &&
      Number.isSafeInteger(bytesPerRow) &&
      bytesPerRow >= width * 8 &&
      bytesPerRow % 2 === 0 &&
      pixels.byteLength === bytesPerRow * height,
    "invalid_resource",
    "Invalid HDR worker pixel layout",
  );
  const bytes = new Uint8Array(width * height * 8);
  const view = new DataView(bytes.buffer);
  const rowElements = bytesPerRow / 2;
  for (let y = 0; y < height; y++) {
    for (let lane = 0; lane < width * 4; lane++) {
      view.setUint16((y * width * 4 + lane) * 2, pixels[y * rowElements + lane], true);
    }
  }
  const content = { kind: "texture_pixels" as const, descriptor };
  const message: PutResource = {
    type: "put_resource",
    ...content,
    hash: contentResourceHashSync(content, bytes),
  };
  return { message, bytes };
}
