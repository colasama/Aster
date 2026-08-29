export const RENDER_HOST_WEBGPU_UNAVAILABLE = "render_host_webgpu_unavailable";
const MAX_RENDER_HOST_FAILURE_MESSAGE = 2_048;

/**
 * Background output must fail explicitly when WebGPU cannot initialize. The Canvas compatibility
 * renderer intentionally omits production-only 3D, effect, depth-of-field, and motion-blur passes,
 * so accepting it here could publish a valid-looking file with different pixels than the beauty path.
 */
export async function createProductionRenderHostRenderer<Renderer>(
  canvas: HTMLCanvasElement,
  createWebGpu: (canvas: HTMLCanvasElement) => Promise<Renderer>,
): Promise<Renderer> {
  try {
    return await createWebGpu(canvas);
  } catch (error) {
    throw new RenderHostWebGpuUnavailableError(error);
  }
}

export class RenderHostWebGpuUnavailableError extends Error {
  readonly code = RENDER_HOST_WEBGPU_UNAVAILABLE;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      "Background rendering requires WebGPU to preserve production pixel parity. " +
        `Check GPU/WebGPU availability and retry. WebGPU initialization failed: ${detail}`,
    );
    this.name = "RenderHostWebGpuUnavailableError";
  }
}

export function renderHostFailure(error: unknown): { code: string; message: string } {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.trim() || "Background rendering failed without an error message.";
  return {
    code: error instanceof RenderHostWebGpuUnavailableError ? error.code : "render_host_failed",
    message:
      message.length <= MAX_RENDER_HOST_FAILURE_MESSAGE
        ? message
        : `${message.slice(0, MAX_RENDER_HOST_FAILURE_MESSAGE - 1)}…`,
  };
}
