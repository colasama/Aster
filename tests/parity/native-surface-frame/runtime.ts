import { FrameBundleRenderer } from "../../../src/renderer/compositing/frame-bundle-renderer";
import { decodeFramePlan } from "../../../src/renderer/frame-plan/codec";
import type { PutResource } from "../../../src/renderer/frame-plan/types";

type Frame = { id: string; plan: number[]; resources: { message: PutResource; bytes: number[] }[] };

async function renderSurfaceFrames(frames: Frame[]) {
  const renderer = await FrameBundleRenderer.create();
  const results = [];
  try {
    for (const frame of frames) {
      const bundle = {
        plan: decodeFramePlan(new Uint8Array(frame.plan)),
        resources: frame.resources.map((r) => ({
          message: r.message,
          bytes: new Uint8Array(r.bytes),
        })),
      };
      results.push({ id: frame.id, pixels: Array.from(await renderer.render(bundle)) });
    }
    return results;
  } finally {
    renderer.destroy();
  }
}

Object.assign(window, { renderSurfaceFrames });
