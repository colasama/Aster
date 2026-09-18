import { BLEND_MODES, type BlendMode } from "../../core/types";
import { transparencyPipeline } from "./transparency-pipeline";
import {
  FRAGMENT_BYTES,
  MAX_PIXEL_FRAGMENTS,
  resolveFragmentsShader,
  TRANSPARENCY_TILE,
} from "./transparent-fragments";

export interface TransparentDraw {
  blendMode: BlendMode;
  triangleCount: number;
  draw(pass: GPURenderPassEncoder): void;
}

/** Tiled per-pixel fragment lists: exact depth ordering without full-frame fragment storage. */
export class ExactTransparencyRenderer {
  readonly #device: GPUDevice;
  readonly #layout: GPUBindGroupLayout;
  readonly #emptyLayout: GPUBindGroupLayout;
  readonly #emptyBinding: GPUBindGroup;
  readonly #resolve: GPURenderPipeline;
  readonly #heads: GPUBuffer;
  readonly #counters: GPUBuffer;
  #fragments?: GPUBuffer;
  #capacity = 0;
  #groupIndex = 0;
  passCount = 0;
  drawCount = 0;
  #groups: Array<{
    uniforms: GPUBuffer;
    bytes: number;
    backdrop: GPUTexture;
    width: number;
    height: number;
  }> = [];
  #pending: Promise<void> = Promise.resolve();
  #failure?: Error;
  #retired: GPUBuffer[] = [];

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#layout = device.createBindGroupLayout({
      entries: [
        ...[0, 1, 2].map((binding) => ({
          binding,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "storage" as const },
        })),
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 32 },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "unfilterable-float" },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 },
        },
      ],
    });
    this.#emptyLayout = device.createBindGroupLayout({ entries: [] });
    this.#emptyBinding = device.createBindGroup({ layout: this.#emptyLayout, entries: [] });
    const module = device.createShaderModule({
      label: "Exact transparency resolve",
      code: resolveFragmentsShader,
    });
    this.#resolve = device.createRenderPipeline({
      label: "Exact transparency resolve",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.#emptyLayout, this.#emptyLayout, this.#emptyLayout, this.#layout],
      }),
      vertex: { module, entryPoint: "vertex_main" },
      fragment: { module, entryPoint: "fragment_main", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
    });
    this.#heads = device.createBuffer({
      size: TRANSPARENCY_TILE ** 2 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.#counters = device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  }

  beginFrame(encoder: GPUCommandEncoder): void {
    if (this.#failure) {
      const failure = this.#failure;
      this.#failure = undefined;
      throw failure;
    }
    this.#groupIndex = 0;
    this.passCount = 0;
    this.drawCount = 0;
    encoder.clearBuffer(this.#counters);
  }

  encode(
    encoder: GPUCommandEncoder,
    target: GPUTexture,
    depth: GPUTextureView,
    width: number,
    height: number,
    draws: readonly TransparentDraw[],
  ): void {
    const fragmentsPerPixel = Math.min(
      MAX_PIXEL_FRAGMENTS,
      draws.reduce((sum, draw) => sum + draw.triangleCount, 0),
    );
    const tile = Math.min(
      TRANSPARENCY_TILE,
      2 ** Math.ceil(Math.log2(Math.max(width, height))),
      2 **
        Math.floor(
          Math.log2(
            Math.sqrt((32 * 1024 * 1024) / (FRAGMENT_BYTES * Math.max(1, fragmentsPerPixel))),
          ),
        ),
    );
    const capacity = tile ** 2 * Math.max(1, fragmentsPerPixel) + 1;
    if (capacity > this.#capacity) {
      if (this.#fragments) this.#retired.push(this.#fragments);
      const size = capacity * FRAGMENT_BYTES;
      if (size > this.#device.limits.maxStorageBufferBindingSize)
        throw new Error("Exact transparency exceeds the device fragment storage limit");
      this.#fragments = this.#device.createBuffer({
        label: "Tiled transparent fragments",
        size,
        usage: GPUBufferUsage.STORAGE,
      });
      this.#capacity = capacity;
    }
    const columns = Math.ceil(width / tile),
      rows = Math.ceil(height / tile);
    const tileCount = columns * rows;
    const bytes = (tileCount + draws.length) * 256;
    if (bytes > this.#device.limits.maxBufferSize)
      throw new Error("Exact transparency draw uniforms exceed the device buffer limit");
    this.passCount += columns * rows * 2;
    this.drawCount += columns * rows * (draws.length + 1);
    const groupIndex = this.#groupIndex++;
    let group = this.#groups[groupIndex];
    if (!group || group.bytes < bytes || group.width !== width || group.height !== height) {
      // Previous-frame resources have already been submitted; WebGPU retains queued use.
      group?.uniforms.destroy();
      group?.backdrop.destroy();
      group = {
        bytes,
        width,
        height,
        uniforms: this.#device.createBuffer({
          size: bytes,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        backdrop: this.#device.createTexture({
          size: [width, height],
          format: "rgba16float",
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
        }),
      };
      this.#groups[groupIndex] = group;
    }
    const uniforms = new Uint32Array(bytes / 4);
    let record = 0;
    for (let y = 0; y < height; y += tile)
      for (let x = 0; x < width; x += tile)
        uniforms.set([x, y, tile, tile, this.#capacity, 0, 0, 0], record++ * 64);
    for (let order = 0; order < draws.length; order++)
      uniforms.set(
        [order, BLEND_MODES.indexOf(draws[order].blendMode), 0, 0],
        (tileCount + order) * 64,
      );
    this.#device.queue.writeBuffer(group.uniforms, 0, uniforms);
    const fragments = this.#fragments;
    if (!fragments) throw new Error("Transparent fragment storage was not allocated");
    const binding = this.#device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: this.#heads } },
        { binding: 1, resource: { buffer: fragments } },
        { binding: 2, resource: { buffer: this.#counters } },
        { binding: 3, resource: { buffer: group.uniforms, size: 32 } },
        { binding: 4, resource: group.backdrop.createView() },
        { binding: 5, resource: { buffer: group.uniforms, size: 16 } },
      ],
    });
    encoder.copyTextureToTexture({ texture: target }, { texture: group.backdrop }, [width, height]);
    record = 0;
    for (let y = 0; y < height; y += tile)
      for (let x = 0; x < width; x += tile) {
        encoder.clearBuffer(this.#heads, 0, tile * tile * 4);
        encoder.clearBuffer(this.#counters, 0, 4);
        const pass = encoder.beginRenderPass({
          label: "Tiled exact fragment capture",
          colorAttachments: [{ view: target.createView(), loadOp: "load", storeOp: "store" }],
          depthStencilAttachment: { view: depth, depthLoadOp: "load", depthStoreOp: "store" },
        });
        pass.setScissorRect(x, y, Math.min(tile, width - x), Math.min(tile, height - y));
        const proxy = new Proxy(pass, {
          get: (object, key) =>
            key === "setPipeline"
              ? (pipeline: GPURenderPipeline) => {
                  object.setPipeline(
                    transparencyPipeline(this.#device, pipeline, this.#layout, this.#emptyLayout),
                  );
                  object.setBindGroup(1, this.#emptyBinding);
                  object.setBindGroup(2, this.#emptyBinding);
                }
              : typeof Reflect.get(object, key) === "function"
                ? Reflect.get(object, key).bind(object)
                : Reflect.get(object, key),
        });
        for (let order = 0; order < draws.length; order++) {
          pass.setBindGroup(3, binding, [record * 256, (tileCount + order) * 256]);
          draws[order].draw(proxy);
        }
        pass.end();
        const resolve = encoder.beginRenderPass({
          label: "Tiled exact fragment resolve",
          colorAttachments: [{ view: target.createView(), loadOp: "load", storeOp: "store" }],
        });
        resolve.setPipeline(this.#resolve);
        for (let index = 0; index < 3; index++) resolve.setBindGroup(index, this.#emptyBinding);
        resolve.setBindGroup(3, binding, [record++ * 256, tileCount * 256]);
        resolve.setScissorRect(x, y, Math.min(tile, width - x), Math.min(tile, height - y));
        resolve.draw(3);
        resolve.end();
      }
  }

  finishFrame(encoder: GPUCommandEncoder): () => void {
    for (const unused of this.#groups.splice(this.#groupIndex)) {
      unused.uniforms.destroy();
      unused.backdrop.destroy();
    }
    if (!this.#groupIndex) return () => {};
    const read = this.#device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyBufferToBuffer(this.#counters, 4, read, 0, 4);
    const retired = this.#retired.splice(0);
    return () => {
      const pending = read
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          if (new Uint32Array(read.getMappedRange())[0])
            this.#failure = new Error(
              `Exact transparency exceeded its ${MAX_PIXEL_FRAGMENTS}-fragment pixel capacity`,
            );
        })
        .catch((error: unknown) => {
          this.#failure = error instanceof Error ? error : new Error(String(error));
        })
        .finally(() => {
          read.destroy();
          for (const buffer of retired) buffer.destroy();
        });
      this.#pending = Promise.all([this.#pending, pending]).then(() => {});
    };
  }

  async complete(): Promise<void> {
    await this.#pending;
    if (this.#failure) throw this.#failure;
  }
  get estimatedBytes(): number {
    return (
      this.#capacity * FRAGMENT_BYTES +
      TRANSPARENCY_TILE ** 2 * 4 +
      this.#groups.reduce((sum, g) => sum + g.bytes + g.width * g.height * 8, 0)
    );
  }
  destroy(): void {
    this.#heads.destroy();
    this.#counters.destroy();
    this.#fragments?.destroy();
    for (const buffer of this.#retired) buffer.destroy();
    for (const g of this.#groups) {
      g.uniforms.destroy();
      g.backdrop.destroy();
    }
  }
}
