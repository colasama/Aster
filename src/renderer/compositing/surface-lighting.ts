import type { FlattenedSceneLayer } from "../../core/scene/scene-evaluation";
import type { Composition, EnvironmentLighting } from "../../core/types";
import type { GeometryBatch } from "../geometry/geometry";
import { MaterialTextureRenderer } from "../media/material-textures";
import { buildSceneLighting, shadowMapSize } from "../scene/scene-lighting";
import { createShadowPipeline } from "../scene/scene-pipelines";

/** The same light, material and shadow evaluators serve root and offscreen compositions. */
export class SurfaceLighting {
  readonly material: MaterialTextureRenderer;
  readonly #device: GPUDevice;
  readonly #layout: GPUBindGroupLayout;
  readonly #buffer: GPUBuffer;
  readonly #sampler: GPUSampler;
  readonly #shadowBinding: GPUBindGroup;
  readonly #pipeline: GPURenderPipeline;
  #shadow?: GPUTexture;
  #size = 0;
  #enabled = false;
  binding?: GPUBindGroup;
  environment?: EnvironmentLighting;

  constructor(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    buffer: GPUBuffer,
    invalidate: () => void,
    diagnostic: (message?: string) => void,
  ) {
    this.#device = device;
    this.#layout = layout;
    this.#buffer = buffer;
    this.#sampler = device.createSampler({
      compare: "less-equal",
      minFilter: "linear",
      magFilter: "linear",
    });
    const shadowLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    });
    this.#shadowBinding = device.createBindGroup({
      layout: shadowLayout,
      entries: [{ binding: 0, resource: { buffer } }],
    });
    this.#pipeline = createShadowPipeline(device, shadowLayout);
    this.material = new MaterialTextureRenderer(
      device,
      "rgba16float",
      layout,
      invalidate,
      diagnostic,
    );
  }

  prepare(
    composition: Composition,
    layers: FlattenedSceneLayer[],
    batches: GeometryBatch[],
    cameraPosition?: readonly [number, number, number],
  ): void {
    const light = layers.find((scene) => scene.layer.kind === "light")?.layer.light;
    this.#enabled = Boolean(light && light.shadowQuality !== "off" && light.kind !== "point");
    const size = this.#enabled ? shadowMapSize(light?.shadowQuality ?? "medium") : 1;
    if (size !== this.#size) {
      this.#shadow?.destroy();
      this.#size = size;
      this.#shadow = this.#device.createTexture({
        label: "Nested composition shadow map",
        size: [size, size],
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.binding = this.#device.createBindGroup({
        layout: this.#layout,
        entries: [
          { binding: 0, resource: { buffer: this.#buffer } },
          { binding: 1, resource: this.#shadow.createView() },
          { binding: 2, resource: this.#sampler },
        ],
      });
    }
    this.environment = composition.environment;
    this.material.prepare(composition, batches);
    this.#device.queue.writeBuffer(
      this.#buffer,
      0,
      buildSceneLighting(layers, composition, this.#enabled, cameraPosition),
    );
  }

  encode(encoder: GPUCommandEncoder, vertices: GPUBuffer, batches: GeometryBatch[]): void {
    if (!this.#enabled || !this.#shadow) return;
    const pass = encoder.beginRenderPass({
      label: "Nested composition shadows",
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.#shadow.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#shadowBinding);
    pass.setVertexBuffer(0, vertices);
    for (const batch of batches)
      if (batch.layer.threeDimensional) pass.draw(batch.vertexCount, 1, batch.firstVertex);
    pass.end();
  }
  get estimatedBytes(): number {
    return this.#size ** 2 * 4 + this.material.estimatedBytes;
  }
  destroy(): void {
    this.#shadow?.destroy();
    this.material.destroy();
  }
}
