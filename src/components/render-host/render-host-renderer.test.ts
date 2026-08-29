import { describe, expect, it, vi } from "vitest";
import {
  createProductionRenderHostRenderer,
  RENDER_HOST_WEBGPU_UNAVAILABLE,
  RenderHostWebGpuUnavailableError,
  renderHostFailure,
} from "./render-host-renderer";

describe("production RenderHost renderer policy", () => {
  it("returns the production WebGPU renderer without wrapping it", async () => {
    const canvas = {} as HTMLCanvasElement;
    const renderer = { backend: "webgpu" };
    const createWebGpu = vi.fn(async () => renderer);

    await expect(createProductionRenderHostRenderer(canvas, createWebGpu)).resolves.toBe(renderer);
    expect(createWebGpu).toHaveBeenCalledExactlyOnceWith(canvas);
  });

  it("rejects instead of publishing incomplete Canvas fallback pixels", async () => {
    const failure = await createProductionRenderHostRenderer({} as HTMLCanvasElement, async () => {
      throw new Error("No compatible adapter");
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RenderHostWebGpuUnavailableError);
    expect(failure).toMatchObject({ code: RENDER_HOST_WEBGPU_UNAVAILABLE });
    expect(String(failure)).toContain("requires WebGPU to preserve production pixel parity");
    expect(String(failure)).toContain("No compatible adapter");
    expect(renderHostFailure(failure)).toMatchObject({
      code: RENDER_HOST_WEBGPU_UNAVAILABLE,
    });
    expect(renderHostFailure(new Error("frame failed"))).toEqual({
      code: "render_host_failed",
      message: "frame failed",
    });
  });

  it("keeps every renderer failure inside the bounded host-report contract", () => {
    const failure = renderHostFailure(new Error("x".repeat(3_000)));
    expect(failure.message).toHaveLength(2_048);
    expect(failure.message.endsWith("…")).toBe(true);
    expect(renderHostFailure(new Error("   ")).message).toBe(
      "Background rendering failed without an error message.",
    );
  });
});
