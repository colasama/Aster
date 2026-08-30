import UTIF from "utif";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { createBlankProject } from "../core/project";
import type { FootageSource } from "../core/types";
import { mediaImportRuntime } from "../importers/media-import-runtime";
import { CanvasFallbackRenderer } from "./canvas-fallback";

const images: MockImage[] = [];
const videos: MockVideo[] = [];

beforeEach(() => {
  images.length = 0;
  videos.length = 0;
  vi.stubGlobal("HTMLCanvasElement", MockCanvas);
  vi.stubGlobal("HTMLImageElement", MockImage);
  vi.stubGlobal("HTMLVideoElement", MockVideo);
  vi.stubGlobal("HTMLMediaElement", { HAVE_CURRENT_DATA: 2 });
  vi.stubGlobal("Image", MockImage);
  vi.stubGlobal("document", {
    createElement: (name: string) => (name === "video" ? new MockVideo() : new MockCanvas()),
  });
  const NativeUrl = globalThis.URL;
  class MockUrl extends NativeUrl {}
  Object.assign(MockUrl, {
    createObjectURL: vi.fn(() => "blob:svg-raster"),
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal("URL", MockUrl);
});

afterEach(() => {
  mediaImportRuntime.clear();
  vi.unstubAllGlobals();
});

describe("Canvas exact-frame resources", () => {
  it.each(["still", "svg", "imageSequence"] as const)(
    "redraws the first %s frame after current-generation decoding",
    async (kind) => {
      const { renderer, context, project, source } = fixture(kind);
      const composition = project.compositions[0];
      if (!composition) throw new Error("Fixture composition is unavailable");
      renderer.render(composition, 0, false, project);
      expect(context.drawImage).not.toHaveBeenCalled();
      const image = images[images.length - 1];
      if (!image) throw new Error("Fixture image is unavailable");
      image.naturalWidth = 16;
      image.complete = true;
      image.dispatchEvent(new Event("load"));

      await renderer.complete();

      expect(context.drawImage).toHaveBeenCalledTimes(1);
      expect(mediaImportRuntime.error(source.id)).toBeUndefined();
      renderer.render(composition, 0, false, project);
      await renderer.complete();
      expect(context.drawImage).toHaveBeenCalledTimes(2);
    },
  );

  it("waits for the exact video seek and redraws before readback", async () => {
    const { renderer, context, project } = fixture("video");
    const composition = project.compositions[0];
    if (!composition) throw new Error("Fixture composition is unavailable");
    renderer.render(composition, 1.25, false, project);
    const video = videos[videos.length - 1];
    if (!video) throw new Error("Fixture video is unavailable");
    expect(context.drawImage).not.toHaveBeenCalled();
    video.readyState = 2;
    video.seeking = false;
    video.currentTime = 1.25;
    video.dispatchEvent(new Event("seeked"));

    await renderer.complete();

    expect(context.drawImage).toHaveBeenCalledTimes(1);
  });

  it("decodes TIFF into a canvas when native image elements cannot decode it", async () => {
    vi.stubGlobal("Worker", undefined);
    class MockImageData {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    }
    vi.stubGlobal("ImageData", MockImageData);
    const encoded = UTIF.encodeImage(Uint8Array.from([20, 40, 80, 255]).buffer, 1, 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob([encoded], { type: "image/tiff" }),
      })),
    );
    const bitmap = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => bitmap),
    );
    const { renderer, context, project, source } = fixture("still");
    source.name = "plate.tiff";
    source.mimeType = "image/tiff";
    const composition = project.compositions[0];
    if (!composition) throw new Error("Fixture composition is unavailable");

    renderer.render(composition, 0, false, project);
    expect(context.drawImage).not.toHaveBeenCalled();
    await renderer.complete();

    expect(context.drawImage).toHaveBeenCalledTimes(1);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(mediaImportRuntime.error(source.id)).toBeUndefined();
  });

  it("rejects a missing sequence generation instead of reading stale pixels", async () => {
    const { renderer, project, source } = fixture("imageSequence");
    mediaImportRuntime.register(source.id, {
      kind: "imageSequence",
      selection: {
        pattern: "frame_[####].png",
        prefix: "frame_",
        extension: ".png",
        padding: 4,
        startFrame: 1,
        endFrame: 2,
        missingFrames: [2],
        frames: [
          {
            frame: 1,
            file: {
              name: "frame_0001.png",
              size: 4,
              lastModified: 1,
              type: "image/png",
              url: "aster-runtime://frame-0001",
            },
          },
        ],
      },
      frameRate: { numerator: 1, denominator: 1 },
      missingFramePolicy: "error",
      loop: false,
    });
    const composition = project.compositions[0];
    if (!composition) throw new Error("Fixture composition is unavailable");
    renderer.render(composition, 1, false, project);

    await expect(renderer.waitForFrameResources()).rejects.toThrow("frame 2 is missing");
  });

  it("disposes video DOM and pending decode state idempotently and rejects reuse", async () => {
    const videoFixture = fixture("video");
    const composition = videoFixture.project.compositions[0];
    if (!composition) throw new Error("Fixture composition is unavailable");
    videoFixture.renderer.render(composition, 1, false, videoFixture.project);
    const video = videos[videos.length - 1];
    if (!video) throw new Error("Fixture video is unavailable");

    videoFixture.renderer.dispose();
    videoFixture.renderer.dispose();

    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.removeAttribute).toHaveBeenCalledWith("src");
    expect(video.load).toHaveBeenCalledTimes(1);
    expect(video.remove).toHaveBeenCalledTimes(1);
    expect(() => videoFixture.renderer.render(composition, 1, false, videoFixture.project)).toThrow(
      "disposed",
    );
    await expect(videoFixture.renderer.complete()).rejects.toThrow("disposed");

    const pendingFixture = fixture("still");
    const pendingComposition = pendingFixture.project.compositions[0];
    if (!pendingComposition) throw new Error("Fixture composition is unavailable");
    pendingFixture.renderer.render(pendingComposition, 0, false, pendingFixture.project);
    const pendingImage = images[images.length - 1];
    pendingFixture.renderer.dispose();
    pendingImage.naturalWidth = 16;
    pendingImage.complete = true;
    pendingImage.dispatchEvent(new Event("load"));
    await Promise.resolve();
    expect(pendingFixture.context.drawImage).not.toHaveBeenCalled();
  });
});

function fixture(kind: "still" | "svg" | "imageSequence" | "video") {
  const project = createBlankProject();
  const composition = project.compositions[0];
  if (!composition) throw new Error("Blank project composition is unavailable");
  composition.layers = [];
  const layer = createLayerForComposition(kind === "video" ? "video" : "image", composition);
  const source = mediaSource(kind);
  layer.sourceId = source.id;
  composition.layers.push(layer);
  project.sources.push(source);
  registerRuntime(source);
  const canvas = new MockCanvas();
  const renderer = new CanvasFallbackRenderer(canvas as unknown as HTMLCanvasElement);
  renderer.resize(320, 180);
  return { renderer, context: canvas.context, project, source };
}

function mediaSource(kind: "still" | "svg" | "imageSequence" | "video"): FootageSource {
  const common = {
    id: `source-${kind}`,
    name: kind,
    mimeType: kind === "svg" ? "image/svg+xml" : kind === "video" ? "video/mp4" : "image/png",
    contentIdentity: kind,
    runtimeUrl: `aster-runtime://${kind}`,
    width: 16,
    height: 16,
    interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
  };
  if (kind === "video") return { ...common, kind, duration: 10 };
  if (kind === "imageSequence")
    return { ...common, kind, pattern: "frame_[####].png", startFrame: 1, endFrame: 1 };
  return { ...common, kind };
}

function registerRuntime(source: FootageSource): void {
  if (source.kind === "svg")
    mediaImportRuntime.register(source.id, {
      kind: "svg",
      parsed: {
        width: 16,
        height: 16,
        viewBox: [0, 0, 16, 16],
        sanitized: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"/>',
        nodeCount: 1,
      },
    });
  if (source.kind === "imageSequence")
    mediaImportRuntime.register(source.id, {
      kind: "imageSequence",
      selection: {
        pattern: "frame_[####].png",
        prefix: "frame_",
        extension: ".png",
        padding: 4,
        startFrame: 1,
        endFrame: 1,
        missingFrames: [],
        frames: [
          {
            frame: 1,
            file: {
              name: "frame_0001.png",
              size: 4,
              lastModified: 1,
              type: "image/png",
              url: "aster-runtime://frame-0001",
            },
          },
        ],
      },
      frameRate: { numerator: 24, denominator: 1 },
      missingFramePolicy: "error",
      loop: false,
    });
}

class MockImage extends EventTarget {
  complete = false;
  naturalWidth = 0;
  src = "";

  constructor() {
    super();
    images.push(this);
  }
}

class MockVideo extends EventTarget {
  currentTime = 0;
  duration = 10;
  error: MediaError | null = null;
  muted = true;
  paused = true;
  playsInline = false;
  preload = "";
  readyState = 0;
  seeking = true;
  src = "";
  volume = 0;
  readonly load = vi.fn();
  readonly pause = vi.fn(() => {
    this.paused = true;
  });
  readonly remove = vi.fn();
  readonly removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });

  constructor() {
    super();
    videos.push(this);
  }

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
}

class MockCanvas {
  width = 320;
  height = 180;
  readonly context: ReturnType<typeof canvasContext>;
  readonly remove = vi.fn();

  constructor() {
    this.context = canvasContext();
    Object.assign(this.context, { canvas: this });
  }

  getContext(): CanvasRenderingContext2D {
    return this.context;
  }
}

function canvasContext() {
  return {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    restore: vi.fn(),
    rotate: vi.fn(),
    save: vi.fn(),
    translate: vi.fn(),
    fillStyle: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
  } as unknown as CanvasRenderingContext2D & { drawImage: ReturnType<typeof vi.fn> };
}
// @vitest-environment happy-dom
