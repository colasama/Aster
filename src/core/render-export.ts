import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Composition } from "./types";

export interface FrameRenderSession {
  renderFrame: (time: number) => Promise<Blob>;
  close: () => void;
}

export interface RenderSequenceProgress {
  current: number;
  total: number;
}

export interface RenderSequenceResult {
  directory: string;
  frames: number;
  cancelled: boolean;
}

export function nativeSequenceExportAvailable(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function openFrameRenderSession(): Promise<FrameRenderSession> {
  const session = await new Promise<FrameRenderSession | undefined>((resolve) => {
    window.dispatchEvent(new CustomEvent("aster:open-render-session", { detail: { resolve } }));
  });
  if (!session) throw new Error("Renderer did not open a frame session");
  return session;
}

export async function renderSingleFrame(time: number): Promise<Blob> {
  const session = await openFrameRenderSession();
  try {
    return await session.renderFrame(time);
  } finally {
    session.close();
  }
}

export async function renderPngSequence(
  composition: Composition,
  onProgress: (progress: RenderSequenceProgress) => void,
  cancelled: () => boolean,
): Promise<RenderSequenceResult | undefined> {
  if (!nativeSequenceExportAvailable()) {
    throw new Error("PNG sequence export is available in the native Aster application");
  }
  const directory = await open({
    directory: true,
    multiple: false,
    title: "Choose a PNG sequence output folder",
  });
  if (typeof directory !== "string") return undefined;
  const frameRate = composition.frameRate.numerator / composition.frameRate.denominator;
  const frameCount = Math.max(1, Math.ceil(composition.duration * frameRate));
  const session = await openFrameRenderSession();
  let completed = 0;
  try {
    for (let frame = 0; frame < frameCount; frame += 1) {
      if (cancelled()) break;
      onProgress({ current: frame, total: frameCount });
      const blob = await session.renderFrame(frame / frameRate);
      const fileName = `frame_${String(frame + 1).padStart(6, "0")}.png`;
      await invoke("save_render_frame", {
        directory,
        fileName,
        data: await blobToBase64(blob),
      });
      completed += 1;
    }
  } finally {
    session.close();
  }
  onProgress({ current: completed, total: frameCount });
  return { directory, frames: completed, cancelled: completed < frameCount };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}
