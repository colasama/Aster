import { logger } from "../core/logger";
import {
  type DepthOfFieldSurfaceTier,
  planAuxiliarySurfaceAllocation,
} from "./auxiliary-buffer-budget";
import {
  buildAuxiliaryBatchIds,
  idBufferCapacityBytes,
  transparencyFallbackDiagnostic,
} from "./auxiliary-buffer-data";
import {
  beginAuxiliaryAggregatePass,
  beginAuxiliaryFrontColorPass,
  beginAuxiliaryMrtPass,
  beginAuxiliaryPeelPass,
} from "./auxiliary-buffer-passes";
import { createAuxiliaryBufferPipelines } from "./auxiliary-buffer-pipelines";
import type { SceneBufferVisualizer } from "./buffer-visualizer";
import type { GeometryBatch } from "./geometry";
import {
  type AuxiliaryBufferKind,
  auxiliaryRenderPassBytes,
  type BufferVisualization,
  createAuxiliaryBufferTextures,
  destroyAuxiliaryBufferTextures,
  isAuxiliaryBuffer,
  planAuxiliaryBuffers,
  supportsAuxiliaryMrt,
  usesAuxiliarySurfaceData,
} from "./render-buffers";
import { GpuTimeAddressedMotionVectors } from "./time-addressed-motion-vectors";

export interface GeneratorDraw {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  indirectBuffer: GPUBuffer;
}

export interface AuxiliaryEncodeRequest {
  encoder: GPUCommandEncoder;
  vertexBuffer: GPUBuffer;
  vertexCount: number;
  batches: readonly GeometryBatch[];
  motionVectors?: Float32Array;
  mediaBindGroup: (batch: GeometryBatch) => GPUBindGroup | undefined;
  generators?: readonly GeneratorDraw[];
}

/** Owns the transient MRT surface-data pass used by the viewport debugger. */
export class AuxiliaryBufferRenderer {
  readonly #device: GPUDevice;
  readonly #shapePipeline: GPURenderPipeline;
  readonly #mediaPipeline: GPURenderPipeline;
  readonly #transparentShapePipeline: GPURenderPipeline;
  readonly #transparentMediaPipeline: GPURenderPipeline;
  readonly #peelShapePipeline: GPURenderPipeline;
  readonly #peelMediaPipeline: GPURenderPipeline;
  readonly #frontColorShapePipeline: GPURenderPipeline;
  readonly #frontColorMediaPipeline: GPURenderPipeline;
  readonly #peelBindGroupLayout: GPUBindGroupLayout;
  readonly #motionVectors: GpuTimeAddressedMotionVectors;
  #textures = new Map<AuxiliaryBufferKind, GPUTexture>();
  #depth?: GPUTexture;
  #transparentWorldPosition?: GPUTexture;
  #peeledWorldPosition?: GPUTexture;
  #frontLayerColor?: GPUTexture;
  #peeledLayerColor?: GPUTexture;
  #peelDepth?: GPUTexture;
  #idBuffer?: GPUBuffer;
  #idBufferBytes = 0;
  #width = 1;
  #height = 1;
  #estimatedBytes = 0;
  #byteBudget = 0;
  #enabled = false;
  #motionShutterScale = 0;
  #allocationFailureReported = false;
  #budgetFailureReported = false;
  #aggregateFallbackReported = false;
  #transparencyFallbackDiagnostic?: string;
  #unavailableReported = false;
  #depthOfFieldTier: DepthOfFieldSurfaceTier = -1;
  #depthOfFieldDiagnostic?: string;
  #degradedTierReported?: DepthOfFieldSurfaceTier;
  readonly supported: boolean;

  constructor(device: GPUDevice, imageBindGroupLayout: GPUBindGroupLayout) {
    this.#device = device;
    this.#motionVectors = new GpuTimeAddressedMotionVectors(device);
    this.supported = supportsAuxiliaryMrt(device.limits);
    const pipelines = createAuxiliaryBufferPipelines(device, imageBindGroupLayout);
    this.#shapePipeline = pipelines.shape;
    this.#mediaPipeline = pipelines.media;
    this.#transparentShapePipeline = pipelines.transparentShape;
    this.#transparentMediaPipeline = pipelines.transparentMedia;
    this.#peelShapePipeline = pipelines.peelShape;
    this.#peelMediaPipeline = pipelines.peelMedia;
    this.#frontColorShapePipeline = pipelines.frontColorShape;
    this.#frontColorMediaPipeline = pipelines.frontColorMedia;
    this.#peelBindGroupLayout = pipelines.peelBindGroupLayout;
  }

  get estimatedBytes(): number {
    return this.#estimatedBytes + this.#idBufferBytes + this.#motionVectors.estimatedBytes;
  }

  get textures(): ReadonlyMap<AuxiliaryBufferKind, GPUTexture> {
    return this.#textures;
  }

  get transparentWorldPosition(): GPUTexture | undefined {
    return this.#transparentWorldPosition;
  }

  get peeledWorldPosition(): GPUTexture | undefined {
    return this.#peeledWorldPosition;
  }

  get frontLayerColor(): GPUTexture | undefined {
    return this.#frontLayerColor;
  }

  get peeledLayerColor(): GPUTexture | undefined {
    return this.#peeledLayerColor;
  }

  get motionShutterScale(): number {
    return this.#motionShutterScale;
  }

  get transparencyFallbackDiagnostic(): string | undefined {
    return this.#transparencyFallbackDiagnostic;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get depthOfFieldTier(): DepthOfFieldSurfaceTier {
    return this.#depthOfFieldTier;
  }

  get depthOfFieldDiagnostic(): string | undefined {
    return this.#depthOfFieldDiagnostic;
  }

  enable(width: number, height: number, byteBudget: number, depthOfField = false): boolean {
    if (!this.supported) {
      this.#depthOfFieldDiagnostic = depthOfField
        ? "Depth of field unavailable: this GPU cannot create the required surface-data MRT"
        : undefined;
      return false;
    }
    this.#byteBudget = Math.max(0, byteBudget);
    const plan = planAuxiliaryBuffers(width, height);
    const allocation = planAuxiliarySurfaceAllocation(
      plan.width,
      plan.height,
      this.#byteBudget,
      depthOfField,
      this.#idBufferBytes + 48,
    );
    if (!allocation) {
      if (this.#enabled) this.#destroyTargets();
      this.#depthOfFieldDiagnostic = depthOfField
        ? "Depth of field unavailable: the base surface-data pass exceeds the GPU memory budget"
        : undefined;
      if (!this.#budgetFailureReported) {
        this.#budgetFailureReported = true;
        logger.warn("webgpu", "auxiliary_buffer_budget_exceeded", {
          plannedBytes: auxiliaryRenderPassBytes(plan) + this.#idBufferBytes + 48,
          byteBudget: this.#byteBudget,
        });
      }
      return false;
    }
    if (
      this.#enabled &&
      plan.width === this.#width &&
      plan.height === this.#height &&
      allocation.depthOfFieldTier === this.#depthOfFieldTier
    ) {
      if (this.estimatedBytes <= this.#byteBudget) {
        this.#depthOfFieldDiagnostic = allocation.diagnostic;
        return true;
      }
      this.#destroyTargets();
      return false;
    }
    this.#destroyTargets();
    try {
      this.#textures = new Map(createAuxiliaryBufferTextures(this.#device, plan));
      this.#depth = this.#device.createTexture({
        label: "Auxiliary MRT depth",
        size: [plan.width, plan.height],
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      if (allocation.depthOfFieldTier >= 1) {
        this.#transparentWorldPosition = this.#createLayerTexture(
          "Transparency-weighted world positions",
          plan.width,
          plan.height,
        );
        this.#frontLayerColor = this.#createLayerTexture(
          "Front transparent layer color",
          plan.width,
          plan.height,
        );
      }
      if (allocation.depthOfFieldTier >= 2) {
        this.#peeledWorldPosition = this.#createLayerTexture(
          "Second peeled world-position layer",
          plan.width,
          plan.height,
        );
        this.#peeledLayerColor = this.#createLayerTexture(
          "Second peeled layer color",
          plan.width,
          plan.height,
        );
        this.#peelDepth = this.#device.createTexture({
          label: "Second transparent layer peel depth",
          size: [plan.width, plan.height],
          format: "depth24plus",
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
      }
      this.#width = plan.width;
      this.#height = plan.height;
      this.#estimatedBytes = allocation.bytes;
      this.#depthOfFieldTier = allocation.depthOfFieldTier;
      this.#depthOfFieldDiagnostic = allocation.diagnostic;
      this.#enabled = true;
      this.#allocationFailureReported = false;
      this.#budgetFailureReported = false;
      this.#unavailableReported = false;
      if (allocation.diagnostic && this.#degradedTierReported !== allocation.depthOfFieldTier) {
        this.#degradedTierReported = allocation.depthOfFieldTier;
        logger.warn("webgpu", "depth_of_field_transparency_degraded", {
          tier: allocation.depthOfFieldTier,
          diagnostic: allocation.diagnostic,
        });
      }
      return true;
    } catch (error) {
      this.#destroyTargets();
      if (!this.#allocationFailureReported) {
        this.#allocationFailureReported = true;
        logger.warn(
          "webgpu",
          "auxiliary_buffer_allocation_failed",
          { width, height, requiredBytes: allocation.bytes },
          error,
        );
      }
      return false;
    }
  }

  disable(): void {
    this.#destroyTargets();
  }

  configureVisualization(
    visualizer: SceneBufferVisualizer,
    mode: BufferVisualization,
    width: number,
    height: number,
    budgetMb?: number,
    forceSurfaceData = false,
    depthOfField = false,
  ): BufferVisualization {
    if (!usesAuxiliarySurfaceData(mode) && !forceSurfaceData) {
      this.disable();
      visualizer.clearAuxiliarySources();
      return mode;
    }
    if (!this.enable(width, height, (budgetMb ?? 512) * 1024 * 1024 * 0.5, depthOfField)) {
      if (
        !this.#budgetFailureReported &&
        !this.#allocationFailureReported &&
        !this.#unavailableReported
      ) {
        this.#unavailableReported = true;
        logger.warn("webgpu", "auxiliary_buffers_unavailable", {
          supported: this.supported,
          width,
          height,
          budgetMb,
        });
      }
      visualizer.clearAuxiliarySources();
      return "beauty";
    }
    const range = Math.max(width, height);
    if (isAuxiliaryBuffer(mode)) visualizer.setAuxiliarySources(this.textures, [-range, range]);
    else visualizer.clearAuxiliarySources();
    return mode;
  }

  encode(request: AuxiliaryEncodeRequest): boolean {
    if (!this.#enabled || !this.#depth) return false;
    const nextIdBytes = idBufferCapacityBytes(request.batches.length);
    const plannedBytes =
      this.#estimatedBytes +
      Math.max(this.#idBufferBytes, nextIdBytes) +
      this.#motionVectors.plannedBytes(request.vertexCount);
    if (plannedBytes > this.#byteBudget) {
      if (!this.#budgetFailureReported) {
        this.#budgetFailureReported = true;
        logger.warn("webgpu", "auxiliary_buffer_budget_exceeded", {
          plannedBytes,
          byteBudget: this.#byteBudget,
        });
      }
      beginAuxiliaryMrtPass(
        request.encoder,
        "Auxiliary MRT budget fallback · cleared",
        this.#textures,
        this.#depth,
      ).end();
      if (this.#depthOfFieldTier >= 1) {
        beginAuxiliaryFrontColorPass(
          request.encoder,
          "Auxiliary front color fallback · cleared",
          this.#frontLayerColor,
          this.#depth,
        ).end();
        beginAuxiliaryAggregatePass(
          request.encoder,
          "Auxiliary transparency fallback · cleared",
          this.#transparentWorldPosition,
        ).end();
      }
      if (this.#depthOfFieldTier >= 2)
        beginAuxiliaryPeelPass(
          request.encoder,
          "Auxiliary depth peel fallback · cleared",
          this.#peeledWorldPosition,
          this.#peeledLayerColor,
          this.#peelDepth,
        ).end();
      this.#motionShutterScale = 0;
      return false;
    }
    this.#budgetFailureReported = false;
    this.#transparencyFallbackDiagnostic = transparencyFallbackDiagnostic(
      this.#depthOfFieldTier >= 0 ? (request.generators?.length ?? 0) : 0,
    );
    if (this.#transparencyFallbackDiagnostic && !this.#aggregateFallbackReported) {
      this.#aggregateFallbackReported = true;
      logger.warn("webgpu", "dof_transparency_aggregate_fallback", {
        reason: this.#transparencyFallbackDiagnostic,
        generatorCount: request.generators?.length ?? 0,
      });
    }
    this.#uploadBatchIds(request.batches);
    const idBuffer = this.#idBuffer;
    if (!idBuffer) return false;
    if (request.motionVectors && request.motionVectors.length !== request.vertexCount * 2)
      throw new Error("Auxiliary motion vectors must match the current geometry vertex count");
    const motionBuffer = request.motionVectors
      ? this.#motionVectors.upload(request.motionVectors)
      : this.#motionVectors.clear(request.vertexCount, request.encoder);
    this.#motionShutterScale = request.motionVectors ? 1 : 0;
    const pass = beginAuxiliaryMrtPass(
      request.encoder,
      "Normal + IDs + World Position + Motion Vector MRT",
      this.#textures,
      this.#depth,
    );
    pass.setVertexBuffer(0, request.vertexBuffer);
    pass.setVertexBuffer(1, idBuffer);
    pass.setVertexBuffer(2, motionBuffer);
    for (let index = 0; index < request.batches.length; index += 1) {
      const batch = request.batches[index];
      const media = request.mediaBindGroup(batch);
      pass.setPipeline(media ? this.#mediaPipeline : this.#shapePipeline);
      if (media) pass.setBindGroup(0, media);
      pass.draw(batch.vertexCount, 1, batch.firstVertex, index);
    }
    for (const generator of request.generators ?? []) {
      pass.setPipeline(generator.pipeline);
      pass.setBindGroup(0, generator.bindGroup);
      pass.drawIndirect(generator.indirectBuffer, 0);
    }
    pass.end();
    if (this.#depthOfFieldTier >= 1) this.#encodeFrontAndAggregate(request, idBuffer, motionBuffer);
    if (this.#depthOfFieldTier >= 2) this.#encodeSecondPeel(request, idBuffer, motionBuffer);
    return true;
  }

  #encodeFrontAndAggregate(
    request: AuxiliaryEncodeRequest,
    idBuffer: GPUBuffer,
    motionBuffer: GPUBuffer,
  ): void {
    const front = beginAuxiliaryFrontColorPass(
      request.encoder,
      "Front layer color surface",
      this.#frontLayerColor,
      this.#depth,
    );
    front.setVertexBuffer(0, request.vertexBuffer);
    front.setVertexBuffer(1, idBuffer);
    front.setVertexBuffer(2, motionBuffer);
    for (let index = 0; index < request.batches.length; index += 1) {
      const batch = request.batches[index];
      const media = request.mediaBindGroup(batch);
      front.setPipeline(media ? this.#frontColorMediaPipeline : this.#frontColorShapePipeline);
      if (media) front.setBindGroup(0, media);
      front.draw(batch.vertexCount, 1, batch.firstVertex, index);
    }
    front.end();

    const aggregate = beginAuxiliaryAggregatePass(
      request.encoder,
      "Transparency-weighted world-position surface",
      this.#transparentWorldPosition,
    );
    aggregate.setVertexBuffer(0, request.vertexBuffer);
    aggregate.setVertexBuffer(1, idBuffer);
    aggregate.setVertexBuffer(2, motionBuffer);
    for (const [index, batch] of request.batches.entries()) {
      const media = request.mediaBindGroup(batch);
      aggregate.setPipeline(
        media ? this.#transparentMediaPipeline : this.#transparentShapePipeline,
      );
      if (media) aggregate.setBindGroup(0, media);
      aggregate.draw(batch.vertexCount, 1, batch.firstVertex, index);
    }
    aggregate.end();
  }

  #encodeSecondPeel(
    request: AuxiliaryEncodeRequest,
    idBuffer: GPUBuffer,
    motionBuffer: GPUBuffer,
  ): void {
    if (!this.#depth) throw new Error("Auxiliary front depth is unavailable");
    const peelBindGroup = this.#device.createBindGroup({
      label: "Auxiliary front-depth peel source",
      layout: this.#peelBindGroupLayout,
      entries: [{ binding: 0, resource: this.#depth.createView() }],
    });
    const peel = beginAuxiliaryPeelPass(
      request.encoder,
      "Second transparent depth layer peel",
      this.#peeledWorldPosition,
      this.#peeledLayerColor,
      this.#peelDepth,
    );
    peel.setVertexBuffer(0, request.vertexBuffer);
    peel.setVertexBuffer(1, idBuffer);
    peel.setVertexBuffer(2, motionBuffer);
    for (const [index, batch] of request.batches.entries()) {
      const media = request.mediaBindGroup(batch);
      peel.setPipeline(media ? this.#peelMediaPipeline : this.#peelShapePipeline);
      if (media) peel.setBindGroup(0, media);
      peel.setBindGroup(1, peelBindGroup);
      peel.draw(batch.vertexCount, 1, batch.firstVertex, index);
    }
    peel.end();
  }

  #createLayerTexture(label: string, width: number, height: number): GPUTexture {
    return this.#device.createTexture({
      label,
      size: [width, height],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  destroy(): void {
    this.#destroyTargets();
    this.#idBuffer?.destroy();
    this.#idBuffer = undefined;
    this.#idBufferBytes = 0;
    this.#motionVectors.destroy();
  }

  #uploadBatchIds(batches: readonly GeometryBatch[]): void {
    const records = buildAuxiliaryBatchIds(batches);
    const requiredBytes = idBufferCapacityBytes(batches.length);
    if (!this.#idBuffer || requiredBytes > this.#idBufferBytes) {
      this.#idBuffer?.destroy();
      this.#idBufferBytes = requiredBytes;
      this.#idBuffer = this.#device.createBuffer({
        label: "Auxiliary object/material ID instances",
        size: this.#idBufferBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    if (records.byteLength > 0) this.#device.queue.writeBuffer(this.#idBuffer, 0, records);
  }

  #destroyTargets(): void {
    destroyAuxiliaryBufferTextures(this.#textures);
    this.#textures.clear();
    this.#depth?.destroy();
    this.#depth = undefined;
    this.#transparentWorldPosition?.destroy();
    this.#transparentWorldPosition = undefined;
    this.#peeledWorldPosition?.destroy();
    this.#peeledWorldPosition = undefined;
    this.#frontLayerColor?.destroy();
    this.#frontLayerColor = undefined;
    this.#peeledLayerColor?.destroy();
    this.#peeledLayerColor = undefined;
    this.#peelDepth?.destroy();
    this.#peelDepth = undefined;
    this.#estimatedBytes = 0;
    this.#enabled = false;
    this.#depthOfFieldTier = -1;
    this.#depthOfFieldDiagnostic = undefined;
    this.#motionVectors.release();
    this.#motionShutterScale = 0;
  }
}

/** Base MRT + depth + K=2 color/depth + aggregate transparency allocation. */
export { auxiliaryDepthOfFieldSurfaceBytes } from "./auxiliary-buffer-budget";
export { buildAuxiliaryBatchIds, transparencyFallbackDiagnostic } from "./auxiliary-buffer-data";

export { auxiliarySurfaceShader } from "./auxiliary-surface-shader";
