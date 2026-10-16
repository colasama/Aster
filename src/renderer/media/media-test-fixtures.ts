import { vi } from "vitest";
import type { FootageSource } from "../../core/types";
import { MediaTextureCache } from "./media-texture-cache";

export function createCache(
  completion: Promise<void> = Promise.resolve(),
  destroy = vi.fn(),
): MediaTextureCache {
  const texture = { createView: vi.fn(() => ({})), destroy };
  const device = {
    limits: { maxTextureDimension2D: 8_192 },
    queue: {
      copyExternalImageToTexture: vi.fn(),
      writeTexture: vi.fn(),
      onSubmittedWorkDone: vi.fn(() => completion),
    },
    createTexture: vi.fn(() => texture),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createBindGroup: vi.fn(() => ({})),
  } as unknown as GPUDevice;
  return new MediaTextureCache(device, {} as GPUBindGroupLayout, {} as GPUSampler, vi.fn());
}

export function still(name: string): FootageSource {
  return {
    id: name,
    kind: "still",
    name,
    mimeType: "image/png",
    contentIdentity: name,
    runtimeUrl: `https://assets.invalid/${name}`,
    width: 16,
    height: 16,
    interpretation: { alpha: "straight", colorSpace: "srgb" },
  };
}

export function videoSource(): FootageSource {
  return {
    id: "video-source",
    kind: "video",
    name: "video.mp4",
    mimeType: "video/mp4",
    contentIdentity: "video-source",
    runtimeUrl: "https://assets.invalid/video.mp4",
    width: 16,
    height: 16,
    duration: 4,
    interpretation: { alpha: "straight", colorSpace: "srgb" },
  };
}

export function bitmap(): ImageBitmap {
  const value = {
    width: 16,
    height: 16,
    close: vi.fn(() => {
      value.width = 0;
      value.height = 0;
    }),
  };
  return value as unknown as ImageBitmap;
}

export function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class MockVideo extends EventTarget {
  crossOrigin: string | null = null;
  currentTime = 0;
  readonly dataset: DOMStringMap = {};
  duration = 4;
  error: MediaError | null = null;
  muted = true;
  paused = true;
  playsInline = false;
  preload = "";
  readyState = 0;
  seeking = false;
  src = "";
  readonly style = {};
  videoHeight = 16;
  videoWidth = 16;
  volume = 0;

  load(): void {}
  pause(): void {
    this.paused = true;
  }
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  remove(): void {}
  removeAttribute(_name: string): void {}
  setAttribute(_name: string, _value: string): void {}
}

export class MockCanvas {
  height = 1;
  width = 1;

  getContext(): CanvasRenderingContext2D {
    return {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(this.width * this.height * 4) })),
    } as unknown as CanvasRenderingContext2D;
  }

  remove(): void {}
  setAttribute(_name: string, _value: string): void {}
}

export class MockTextCanvas {
  height = 1;
  width = 1;

  getContext(): CanvasRenderingContext2D {
    return {
      fillText: vi.fn(),
      filter: "none",
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(this.width * this.height * 4) })),
      globalAlpha: 1,
      measureText: vi.fn((text: string) => ({ width: text.length })),
      restore: vi.fn(),
      rotate: vi.fn(),
      save: vi.fn(),
      scale: vi.fn(),
      strokeText: vi.fn(),
      transform: vi.fn(),
      translate: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
  }
}

export function mockTextEncoder(
  records: Array<{ label: string; draws: number }>,
): GPUCommandEncoder {
  return {
    copyBufferToTexture: vi.fn(),
    beginRenderPass: vi.fn((descriptor: GPURenderPassDescriptor) => {
      const record = { label: String(descriptor.label ?? ""), draws: 0 };
      records.push(record);
      return {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        draw: vi.fn(() => {
          record.draws += 1;
        }),
        end: vi.fn(),
      };
    }),
  } as unknown as GPUCommandEncoder;
}
