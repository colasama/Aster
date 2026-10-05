import { logger } from "../../core/logger";
import type { SceneBufferVisualizer } from "../diagnostics/buffer-visualizer";
import {
  auxiliaryTextureKey,
  buildAuxiliaryPlan,
  readAuxiliaryPlan,
} from "../frame-plan/auxiliary-plan";
import { requirePlan } from "../frame-plan/canonical";
import { compositionIdentityToString } from "../frame-plan/composition-identity";
import type { FramePlanSliceData } from "../frame-plan/types";
import { FLOATS_PER_VERTEX } from "../geometry/geometry";
import { GpuTimeAddressedMotionVectors } from "../scene/time-addressed-motion-vectors";
import {
  type DepthOfFieldSurfaceTier,
  planAuxiliarySurfaceAllocation,
} from "./auxiliary-buffer-budget";
import { idBufferCapacityBytes, transparencyFallbackDiagnostic } from "./auxiliary-buffer-data";
import { createAuxiliaryBufferPipelines } from "./auxiliary-buffer-pipelines";
import {
  type AuxiliaryPlanBindings,
  type AuxiliaryPlanRequest,
  captureAuxiliaryDraws,
} from "./auxiliary-plan-bindings";
import { executeAuxiliaryPasses, validateAuxiliaryTargets } from "./auxiliary-plan-execution";
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

/** Owns the transient MRT surface-data pass used by the viewport debugger. */
export class AuxiliaryBufferRenderer {
  readonly #device: GPUDevice;
  readonly #pipelines: ReturnType<typeof createAuxiliaryBufferPipelines>;
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
    this.#pipelines = createAuxiliaryBufferPipelines(device, imageBindGroupLayout);
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

  buildPlan(request: AuxiliaryPlanRequest): {
    plan: FramePlanSliceData;
    bindings: AuxiliaryPlanBindings;
  } {
    const empty = (status: "unavailable" | "cleared") => ({
      plan: buildAuxiliaryPlan(
        request.header,
        {
          status,
          tier: status === "unavailable" ? -1 : this.#depthOfFieldTier,
          vertex_count: 0,
          draws: [],
          generators: [],
        },
        new Uint32Array(),
      ),
      bindings: { media: new Map(), generators: new Map() },
    });
    if (!this.#enabled || !this.#depth) return empty("unavailable");
    const plannedBytes =
      this.#estimatedBytes +
      Math.max(this.#idBufferBytes, idBufferCapacityBytes(request.batches.length)) +
      this.#motionVectors.plannedBytes(request.vertexCount);
    if (plannedBytes > this.#byteBudget) {
      if (!this.#budgetFailureReported) {
        this.#budgetFailureReported = true;
        logger.warn("webgpu", "auxiliary_buffer_budget_exceeded", {
          plannedBytes,
          byteBudget: this.#byteBudget,
        });
      }
      return empty("cleared");
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
    const captured = captureAuxiliaryDraws(request);
    return {
      plan: buildAuxiliaryPlan(
        request.header,
        {
          status: "drawn",
          tier: this.#depthOfFieldTier,
          vertex_count: request.vertexCount,
          draws: captured.draws,
          generators: captured.generatorIds,
        },
        captured.ids,
        request.motionVectors,
      ),
      bindings: captured.bindings,
    };
  }

  encodePlan(
    encoder: GPUCommandEncoder,
    plan: FramePlanSliceData,
    vertexBuffer: GPUBuffer,
    bindings: AuxiliaryPlanBindings,
  ): boolean {
    const { header, slice, ids, motion } = readAuxiliaryPlan(plan);
    if (slice.status === "unavailable") {
      this.#motionShutterScale = 0;
      return false;
    }
    requirePlan(
      this.#enabled && this.#depth,
      "missing_resource",
      "Auxiliary targets are unavailable",
    );
    requirePlan(
      header.render_target.width === this.#width && header.render_target.height === this.#height,
      "resource_generation_mismatch",
      "Auxiliary target dimensions differ from plan",
    );
    requirePlan(
      this.#depthOfFieldTier >= slice.tier,
      "missing_resource",
      "Auxiliary attachment tier is unavailable",
    );
    const targets = {
      textures: this.#textures,
      depth: this.#depth,
      frontColor: this.#frontLayerColor,
      aggregate: this.#transparentWorldPosition,
      peeledPosition: this.#peeledWorldPosition,
      peeledColor: this.#peeledLayerColor,
      peelDepth: this.#peelDepth,
    };
    validateAuxiliaryTargets(slice, targets);
    const media = slice.draws.map((draw) => {
      if (draw.texture.kind === "none") return undefined;
      const binding = bindings.media.get(auxiliaryTextureKey(draw.texture));
      requirePlan(binding, "missing_resource", "Planned auxiliary texture binding is unavailable");
      return binding;
    });
    const generators = slice.generators.map((id) => {
      const draw = bindings.generators.get(compositionIdentityToString(id));
      requirePlan(draw, "missing_resource", "Planned auxiliary generator is unavailable");
      return draw;
    });
    let motionBuffer: GPUBuffer | undefined;
    if (slice.status === "drawn") {
      requirePlan(
        vertexBuffer.size >= slice.vertex_count * FLOATS_PER_VERTEX * 4,
        "invalid_header",
        "Auxiliary geometry buffer is too small",
      );
      const bytes =
        this.#estimatedBytes +
        Math.max(this.#idBufferBytes, idBufferCapacityBytes(slice.draws.length)) +
        this.#motionVectors.plannedBytes(slice.vertex_count);
      requirePlan(
        bytes <= this.#byteBudget,
        "resource_budget_exceeded",
        "Supplied auxiliary plan exceeds available GPU budget",
      );
      this.#uploadBatchIds(ids);
      motionBuffer = motion
        ? this.#motionVectors.upload(motion)
        : this.#motionVectors.clear(slice.vertex_count, encoder);
    }
    executeAuxiliaryPasses({
      device: this.#device,
      encoder,
      slice,
      targets,
      pipelines: this.#pipelines,
      vertexBuffer,
      ids: this.#idBuffer,
      motion: motionBuffer,
      media,
      generators,
    });
    this.#motionShutterScale = motion ? 1 : 0;
    return slice.status === "drawn";
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

  #uploadBatchIds(records: Uint32Array): void {
    const requiredBytes = idBufferCapacityBytes(records.length / 2);
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
