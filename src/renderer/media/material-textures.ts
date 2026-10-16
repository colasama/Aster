import { logger } from "../../core/logger";
import { runCpuTask } from "../../core/scheduling/cpu-scheduler";
import type { BlendMode, Composition, EnvironmentLighting, Layer } from "../../core/types";
import { requirePlan } from "../frame-plan/canonical";
import {
  buildMaterialBindingSlice,
  readMaterialBindingSlice,
} from "../frame-plan/material-binding-plan";
import type { BundleResource } from "../frame-plan/precomposition-bundle-resources";
import type { FrameHeaderSlice } from "../frame-plan/types";
import { prepareEncodedTexture, uploadEncodedTexture } from "./encoded-texture-upload";
import { prepareHdrTexture } from "./hdr-texture-resource";
import { MaterialGpuBindings, type MaterialTextureBinding } from "./material-gpu-bindings";
import { type MaterialBindingPlan, planMaterialTextures } from "./material-texture-plan";
import { abortError, remainingTimeout, waitWithTimeout } from "./media-loading";
import { uploadTexturePixels } from "./texture-pixel-upload";

export { type MaterialTexturePlan, planMaterialTextures } from "./material-texture-plan";

interface NormalResource {
  source: string;
  hash?: string;
  packet?: BundleResource;
  texture?: GPUTexture;
  bytes: number;
  state: "loading" | "ready" | "failed";
  abort: AbortController;
  diagnosticReported?: boolean;
  pending?: Promise<void>;
}

interface EnvironmentResource {
  source: string;
  hash?: string;
  packet?: BundleResource;
  texture?: GPUTexture;
  bytes: number;
  state: "loading" | "ready" | "failed";
  abort: AbortController;
  diagnosticReported?: boolean;
  pending?: Promise<void>;
}

export {
  HDR_ENVIRONMENT_SAMPLER_DESCRIPTOR,
  type MaterialTextureBinding,
  NORMAL_MAP_SAMPLER_DESCRIPTOR,
} from "./material-gpu-bindings";

/** Lazily owns mesh material maps so the default beauty path pays no texture or pipeline cost. */
export class MaterialTextureRenderer {
  readonly #device: GPUDevice;
  readonly #gpu: MaterialGpuBindings;
  readonly #invalidate: () => void;
  readonly #reportDiagnostic: (message?: string) => void;
  readonly #normals = new Map<string, NormalResource>();
  readonly #failures = new Map<string, string>();
  #environment?: EnvironmentResource;
  readonly #lifetime = new AbortController();

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    lightingLayout: GPUBindGroupLayout,
    invalidate: () => void,
    reportDiagnostic: (message?: string) => void,
  ) {
    this.#device = device;
    this.#invalidate = invalidate;
    this.#reportDiagnostic = reportDiagnostic;
    this.#gpu = new MaterialGpuBindings(device, format, lightingLayout);
  }

  destroy(): void {
    this.#lifetime.abort(new Error("Material textures were destroyed during frame capture"));
    for (const resource of this.#normals.values()) {
      this.#retire(resource);
    }
    this.#normals.clear();
    this.#retire(this.#environment);
    this.#environment = undefined;
    this.#gpu.destroy();
    this.#failures.clear();
  }

  /** True while a normal map or environment is still decoding into its fallback texel. */
  get hasPendingResources(): boolean {
    if (this.#environment?.state === "loading") return true;
    for (const resource of this.#normals.values()) if (resource.state === "loading") return true;
    return false;
  }

  /** Exact captures wait for active material generations; preview can still use fallbacks. */
  async waitForFrameResources(timeoutMs = 10_000): Promise<void> {
    const started = performance.now();
    while (true) {
      if (this.#lifetime.signal.aborted) throw abortError(this.#lifetime.signal.reason);
      const pending = [...this.#normals.values(), this.#environment].filter(
        (resource) => resource?.state === "loading",
      );
      if (pending.length === 0) {
        const failure = this.#failures.values().next().value;
        if (failure) throw new Error(failure);
        return;
      }
      await Promise.all(
        pending.map(async (resource) => {
          if (!resource) return;
          try {
            await waitWithTimeout(
              resource.pending ?? Promise.resolve(),
              remainingTimeout(started, timeoutMs),
              resource.abort.signal,
              "Timed out waiting for exact material textures",
            );
          } catch (error) {
            // Retired generations no longer belong to the requested frame.
            if (!resource.abort.signal.aborted) throw error;
          }
        }),
      );
    }
  }

  get estimatedBytes(): number {
    let normalBytes = 0;
    for (const resource of this.#normals.values()) normalBytes += resource.bytes;
    return normalBytes + (this.#environment?.bytes ?? 0) + this.#gpu.uniformBytes;
  }

  prepare(
    composition: Composition,
    batches: readonly {
      layer: Layer;
      resourceInstanceId: string;
      materialTexturePlan?: MaterialBindingPlan;
    }[],
    header: FrameHeaderSlice,
  ): void {
    const environmentActive = Boolean(
      composition.environment?.enabled && batches.some((batch) => batch.layer.kind === "mesh"),
    );
    const activeNormalInstances = new Set<string>();
    const activeBindingInstances = new Set<string>();
    for (const batch of batches) {
      const source = batch.layer.mesh?.materialTextures?.normal?.dataUrl;
      if (batch.layer.kind !== "mesh") continue;
      if (source || environmentActive) activeBindingInstances.add(batch.resourceInstanceId);
      if (!source) continue;
      activeNormalInstances.add(batch.resourceInstanceId);
      this.#prepareNormal(batch.resourceInstanceId, source);
    }
    for (const [instanceId, resource] of this.#normals) {
      if (activeNormalInstances.has(instanceId)) continue;
      this.#retire(resource);
      this.#normals.delete(instanceId);
      this.#clearFailure(`normal:${instanceId}`);
      this.#gpu.remove(instanceId);
    }
    this.#gpu.sweep(activeBindingInstances);
    this.#prepareEnvironment(environmentActive ? composition.environment : undefined);
    for (const batch of batches) {
      batch.materialTexturePlan = undefined;
      if (batch.layer.kind !== "mesh") continue;
      const normal = this.#normals.get(batch.resourceInstanceId);
      const material: MaterialBindingPlan = {
        ...planMaterialTextures(
          batch.layer,
          composition.environment,
          normal?.state === "ready",
          this.#environment?.state === "ready",
        ),
        instanceId: batch.resourceInstanceId,
        normalHash: normal?.state === "ready" ? (normal.hash ?? null) : null,
        environmentHash:
          this.#environment?.state === "ready" ? (this.#environment.hash ?? null) : null,
      };
      batch.materialTexturePlan = readMaterialBindingSlice(
        buildMaterialBindingSlice(header, material),
      );
    }
  }

  /** Borrow cached wire payloads; bundle construction takes ownership without GPU readback. */
  resourcePackets(hashes: readonly string[]): BundleResource[] {
    const entries = [...this.#normals.values(), this.#environment];
    return [...new Set(hashes)].map((hash) => {
      const resource = entries.find((entry) => entry?.state === "ready" && entry.hash === hash);
      requirePlan(resource?.packet, "missing_resource", "Material payload is no longer resident");
      return resource.packet;
    });
  }

  bindingFor(
    plan: MaterialBindingPlan | undefined,
    blendMode: BlendMode,
  ): MaterialTextureBinding | undefined {
    return this.#gpu.bindingFor(plan, blendMode);
  }

  #retire(resource: NormalResource | EnvironmentResource | undefined): void {
    if (!resource) return;
    resource.abort.abort();
    this.#gpu.retire(resource.hash, resource.texture);
    resource.texture?.destroy();
    resource.packet = undefined;
  }

  #prepareNormal(instanceId: string, source: string): void {
    const existing = this.#normals.get(instanceId);
    if (existing?.source === source) return;
    this.#retire(existing);
    const abort = new AbortController();
    const resource: NormalResource = {
      source,
      bytes: 0,
      state: "loading",
      abort,
    };
    this.#normals.set(instanceId, resource);
    this.#clearFailure(`normal:${instanceId}`);
    this.#gpu.invalidate(instanceId);
    resource.pending = fetch(source, { signal: abort.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Normal map request failed with HTTP ${response.status}`);
        return response.blob();
      })
      .then(prepareEncodedTexture)
      .then(async (prepared) => {
        if (this.#normals.get(instanceId) !== resource || abort.signal.aborted) return;
        const uploaded = await uploadEncodedTexture(
          this.#device,
          prepared.message,
          prepared.bytes,
          `Linear mesh normal map · ${instanceId}`,
        );
        if (this.#normals.get(instanceId) !== resource || abort.signal.aborted) {
          uploaded.texture.destroy();
          return;
        }
        resource.texture = uploaded.texture;
        resource.hash = prepared.message.hash;
        resource.packet = prepared;
        resource.bytes = uploaded.bytes;
        resource.state = "ready";
        this.#gpu.register(resource.hash, "normal", uploaded.texture);
        this.#clearFailure(`normal:${instanceId}`);
        this.#gpu.invalidate(instanceId);
        this.#invalidate();
      })
      .catch((error) => {
        if (abort.signal.aborted || this.#normals.get(instanceId) !== resource) return;
        resource.state = "failed";
        this.#reportFailure(resource, `normal:${instanceId}`, `Normal map ${instanceId}`, error);
      });
  }

  #prepareEnvironment(environment: EnvironmentLighting | undefined): void {
    const source = environment?.enabled ? environment.source.dataUrl : undefined;
    if (!source) {
      if (!this.#environment) return;
      this.#retire(this.#environment);
      this.#environment = undefined;
      this.#clearFailure("environment");
      this.#gpu.invalidate();
      return;
    }
    if (this.#environment?.source === source) return;
    this.#retire(this.#environment);
    const abort = new AbortController();
    const resource: EnvironmentResource = {
      source,
      bytes: 0,
      state: "loading",
      abort,
    };
    const sourceName = environment?.source.name ?? "environment.hdr";
    this.#environment = resource;
    this.#clearFailure("environment");
    this.#gpu.invalidate();
    if (source.length > 64 * 1024 * 1024) {
      resource.state = "failed";
      this.#reportFailure(
        resource,
        "environment",
        `HDR environment ${sourceName}`,
        new Error("encoded source exceeds 64 MiB"),
      );
      return;
    }
    resource.pending = fetch(source, { signal: abort.signal })
      .then((response) => {
        if (!response.ok)
          throw new Error(`HDR environment request failed with HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((buffer) =>
        runCpuTask(
          { kind: "decode-radiance-hdr", source: buffer },
          {
            priority: "interactive",
            requireWorker: true,
            signal: abort.signal,
            timeoutMs: 30_000,
            transfer: [buffer],
          },
        ),
      )
      .then(async (decoded) => {
        if (this.#environment !== resource || abort.signal.aborted) return;
        const prepared = prepareHdrTexture(decoded);
        this.#device.pushErrorScope("validation");
        let texture: GPUTexture | undefined;
        try {
          let validationError: GPUError | null;
          try {
            texture = uploadTexturePixels(
              this.#device,
              prepared.message,
              prepared.bytes,
              `Linear HDR environment · ${sourceName}`,
            );
          } finally {
            validationError = await this.#device.popErrorScope();
          }
          if (validationError)
            throw new Error(`HDR environment GPU upload failed: ${validationError.message}`);
        } catch (error) {
          texture?.destroy();
          throw error;
        }
        if (this.#environment !== resource) {
          texture.destroy();
          return;
        }
        resource.texture = texture;
        resource.hash = prepared.message.hash;
        resource.packet = prepared;
        this.#gpu.register(resource.hash, "environment", texture);
        resource.bytes = decoded.width * decoded.height * 8;
        resource.state = "ready";
        this.#clearFailure("environment");
        this.#gpu.invalidate();
        this.#invalidate();
      })
      .catch((error) => {
        if (abort.signal.aborted || this.#environment !== resource) return;
        resource.state = "failed";
        this.#reportFailure(resource, "environment", `HDR environment ${sourceName}`, error);
      });
  }

  #reportFailure(
    resource: NormalResource | EnvironmentResource,
    key: string,
    label: string,
    error: unknown,
  ): void {
    if (resource.diagnosticReported) return;
    resource.diagnosticReported = true;
    const message = `${label} failed: ${error instanceof Error ? error.message : String(error)}`;
    this.#failures.set(key, message);
    logger.warn("webgpu", "material_texture_failed", { resource: key, message }, error);
    this.#updateDiagnostic();
    this.#invalidate();
  }

  #clearFailure(key: string): void {
    if (!this.#failures.delete(key)) return;
    this.#updateDiagnostic();
  }

  #updateDiagnostic(): void {
    this.#reportDiagnostic(this.#failures.values().next().value);
  }
}
