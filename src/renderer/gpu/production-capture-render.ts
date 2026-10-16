import {
  copyRenderSnapshotIdentity,
  type RenderSnapshotIdentity,
} from "../../core/rendering/render-snapshot";
import type { Composition, Project } from "../../core/types";
import type { WebGpuRenderer } from "../webgpu-renderer";

export type ProductionFrameRequest = [
  composition: Composition,
  time: number,
  snapshot: RenderSnapshotIdentity,
  project?: Project,
  synchronizeVideo?: boolean,
];
export type RawProductionFrameRequest = [
  ...ProductionFrameRequest,
  destination?: ArrayBuffer,
  captureBundle?: boolean,
];
export type ProductionCaptureRenderer = Pick<
  WebGpuRenderer,
  "render" | "productionRenderError" | "outputWidth" | "outputHeight"
>;

/** Freeze identity before queued discovery, and surface failures from either capture mode. */
export function productionCaptureRender(
  renderer: ProductionCaptureRenderer,
  composition: Composition,
  time: number,
  snapshot: RenderSnapshotIdentity,
  project?: Project,
): (holdInexactVideo: boolean) => void {
  const capturedSnapshot = copyRenderSnapshotIdentity(snapshot);
  return (holdInexactVideo) => {
    renderer.render(
      composition,
      time,
      capturedSnapshot,
      false,
      project,
      undefined,
      true,
      holdInexactVideo,
    );
    const error = renderer.productionRenderError;
    if (error) throw new Error(error);
  };
}
