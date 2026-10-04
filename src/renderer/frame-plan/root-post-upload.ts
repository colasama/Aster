import type { AntiAliasingMode } from "../../core/rendering/anti-aliasing";
import { requirePlan } from "./canonical";
import { defaultFramePlanLimits, type Extent2d, type FramePlanSliceData } from "./types";
import { validateMetadata, validatePostUniforms } from "./validation";

export interface RootPostUniformDestination {
  queue: Pick<GPUQueue, "writeBuffer">;
  buffer: GPUBuffer;
  target: Extent2d;
  renderTarget: Extent2d;
  antiAliasing: AntiAliasingMode;
}

/** Executes only the supplied root uniform slice; it has no project or evaluation inputs. */
export function uploadRootPostUniformPlan(
  plan: FramePlanSliceData,
  destination: RootPostUniformDestination,
): void {
  const metadata = validateMetadata(plan.metadata, defaultFramePlanLimits());
  requirePlan(
    metadata.slices.length === 1 &&
      metadata.blobs.length === 1 &&
      metadata.resources.length === 0 &&
      plan.blobs.length === 1,
    "invalid_post_uniforms",
    "Root upload requires one uniform slice without resource references",
  );
  const header = metadata.header;
  requirePlan(
    header.target.width === destination.target.width &&
      header.target.height === destination.target.height &&
      header.render_target.width === destination.renderTarget.width &&
      header.render_target.height === destination.renderTarget.height &&
      header.aa === destination.antiAliasing,
    "invalid_post_uniforms",
    "Root plan target or AA differs from the prepared destination",
  );
  const bytes = plan.blobs[metadata.slices[0].blob_index];
  requirePlan(bytes instanceof Uint8Array, "invalid_post_uniforms", "Missing root uniform bytes");
  validatePostUniforms(bytes, metadata, true);
  const uniforms = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  requirePlan(
    uniforms.getFloat32(64, true) === 0 &&
      uniforms.getFloat32(68, true) === 0 &&
      uniforms.getFloat32(72, true) === 0 &&
      uniforms.getFloat32(76, true) === 0,
    "invalid_post_uniforms",
    "Root uniform slice requires zero operation count, linear output, blur LOD and masked glow",
  );
  destination.queue.writeBuffer(
    destination.buffer,
    0,
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
}
