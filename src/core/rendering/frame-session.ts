import type { RawFramePixelFormat, RawVideoFrame } from "../../renderer/gpu/frame-readback";
import type { Project } from "../types";
import { copyRenderSnapshotIdentity, type RenderSnapshotIdentity } from "./render-snapshot";

export interface FrameRenderSession {
  renderFrame: (time: number) => Promise<Blob>;
  renderRawFrame: (time: number) => Promise<RawVideoFrame>;
  rawPixelFormat: RawFramePixelFormat;
  width: number;
  height: number;
  maxInFlightFrames: number;
  videoSynchronization: "none" | "seek-and-await";
  close: () => void;
}

export interface FrameRenderSessionOptions {
  project?: Project;
  snapshot?: RenderSnapshotIdentity;
  maxDimension?: number;
}

export interface FrameRenderSessionOpenRequest {
  options: FrameRenderSessionOptions;
  resolve: (session: FrameRenderSession) => void;
  reject: (error: Error) => void;
}

export async function openFrameRenderSession(
  options: FrameRenderSessionOptions = {},
): Promise<FrameRenderSession> {
  if (options.project && !options.snapshot)
    throw new Error("An explicit render project requires its snapshot identity");
  if (options.snapshot && !options.project)
    throw new Error("A render snapshot identity requires its captured project");
  const capturedOptions = {
    ...options,
    ...(options.snapshot ? { snapshot: copyRenderSnapshotIdentity(options.snapshot) } : {}),
  };
  return new Promise<FrameRenderSession>((resolve, reject) => {
    let handled = false;
    window.dispatchEvent(
      new CustomEvent<FrameRenderSessionOpenRequest>("aster:open-render-session", {
        detail: {
          options: capturedOptions,
          resolve: (session) => {
            handled = true;
            resolve(session);
          },
          reject: (error) => {
            handled = true;
            reject(error);
          },
        },
      }),
    );
    queueMicrotask(() => {
      if (!handled) reject(new Error("Renderer did not handle the frame session request"));
    });
  });
}
