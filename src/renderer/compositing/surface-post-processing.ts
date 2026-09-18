import {
  compositionMotionBlurSettings,
  layerMotionBlurEnabled,
  layerSupportsMotionBlur,
  motionBlurInterval,
} from "../../core/animation/motion-blur";
import { evaluateCameraBasis } from "../../core/scene/camera-rig";
import type { Composition } from "../../core/types";
import {
  DepthEffectsRenderer,
  depthEffectSettingsFromCameraOptics,
} from "../effects/depth-effects";
import { FLOATS_PER_VERTEX, type GeometryResult, type SceneCamera } from "../geometry/geometry";
import { productionDepthOfFieldAllocationError } from "../gpu/auxiliary-buffer-budget";
import {
  AuxiliaryBufferRenderer,
  type AuxiliaryEncodeRequest,
} from "../gpu/auxiliary-buffer-renderer";
import { buildTimeAddressedMotionVectors } from "../scene/time-addressed-motion-vectors";
import { type MotionBlurFrameSettings, MotionBlurRenderer } from "./motion-blur-renderer";

/** Root camera post-processing reused in scene-linear space before a source becomes footage. */
export class SurfacePostProcessing {
  readonly #device: GPUDevice;
  readonly #auxiliary: AuxiliaryBufferRenderer;
  readonly #depth: DepthEffectsRenderer;
  readonly #motion: MotionBlurRenderer;
  #depthOutput?: GPUTexture;
  #width = 0;
  #height = 0;
  #depthEnabled = false;
  #motionSettings?: MotionBlurFrameSettings;
  #motionVectors?: Float32Array;
  #source?: GPUTexture;
  #enabled = false;

  constructor(device: GPUDevice, mediaLayout: GPUBindGroupLayout) {
    this.#device = device;
    this.#auxiliary = new AuxiliaryBufferRenderer(device, mediaLayout);
    this.#depth = new DepthEffectsRenderer(device, "rgba16float", true);
    this.#motion = new MotionBlurRenderer(device);
  }

  static needed(
    composition: Composition,
    camera: SceneCamera | undefined,
    geometry: GeometryResult,
  ): boolean {
    return (
      Boolean(camera?.optics.depthOfField && camera.projection.kind === "perspective") ||
      (composition.motionBlur.enabled &&
        composition.motionBlur.shutterAngle > 0 &&
        geometry.batches.some(
          (batch) => layerMotionBlurEnabled(batch.layer) && layerSupportsMotionBlur(batch.layer),
        ))
    );
  }

  prepare(
    composition: Composition,
    time: number,
    camera: SceneCamera | undefined,
    geometry: GeometryResult,
    sample: (time: number) => GeometryResult,
    source: GPUTexture,
    width: number,
    height: number,
    budgetMb = 512,
  ): void {
    this.#enabled = SurfacePostProcessing.needed(composition, camera, geometry);
    if (!this.#enabled) return;
    this.#source = source;
    this.#depthEnabled = Boolean(
      camera?.optics.depthOfField && camera.projection.kind === "perspective",
    );
    const resized = this.#width !== width || this.#height !== height;
    this.#width = width;
    this.#height = height;
    if (!this.#auxiliary.enable(width, height, budgetMb * 1024 * 1024 * 0.5, this.#depthEnabled))
      throw new Error("Nested camera post-processing exceeds its GPU buffer budget");
    const depthError = productionDepthOfFieldAllocationError(
      this.#depthEnabled,
      this.#auxiliary.depthOfFieldTier,
      this.#auxiliary.depthOfFieldDiagnostic,
    );
    if (depthError) throw new Error(depthError);
    const settings = compositionMotionBlurSettings(composition);
    const ids = new Set(
      geometry.batches
        .filter(
          (batch) => layerMotionBlurEnabled(batch.layer) && layerSupportsMotionBlur(batch.layer),
        )
        .map((batch) => batch.selectionId),
    );
    this.#motionSettings = undefined;
    this.#motionVectors = undefined;
    if (settings.enabled && settings.shutterAngle > 0 && ids.size) {
      const interval = motionBlurInterval(
        time,
        composition.frameRate.numerator / composition.frameRate.denominator,
        settings,
      );
      this.#motionVectors = buildTimeAddressedMotionVectors(
        geometry,
        sample(interval.openTime),
        sample(interval.closeTime),
        ids,
      );
      this.#motionSettings = {
        ...settings,
        framePosition:
          interval.duration > Number.EPSILON ? (time - interval.openTime) / interval.duration : 0.5,
        maximumRadius: Math.max(1, Math.min(256, (256 * width) / composition.width)),
      };
    }
    this.#motion.setSources(
      width,
      height,
      this.#motionSettings ? source : undefined,
      this.#auxiliary.textures.get("motionVector"),
      this.#auxiliary.textures.get("objectId"),
      budgetMb * 1024 * 1024 * 0.25,
    );
    if (this.#motionSettings && !this.#motion.outputTexture)
      throw new Error("Nested motion blur exceeds its GPU texture budget");
    if (this.#depthEnabled && camera) {
      if (resized || !this.#depthOutput) {
        this.#depthOutput?.destroy();
        this.#depthOutput = this.#device.createTexture({
          label: "Nested camera linear depth of field",
          size: [width, height],
          format: "rgba16float",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
      }
      this.#depth.setSources(
        width,
        height,
        this.#motionSettings ? this.#motion.outputTexture : source,
        this.#auxiliary.textures.get("worldPosition"),
        this.#auxiliary.transparentWorldPosition,
        this.#auxiliary.peeledWorldPosition,
        this.#auxiliary.frontLayerColor,
        this.#auxiliary.peeledLayerColor,
      );
      this.#depth.setSettings({
        cameraPosition: camera.pose.position,
        cameraForward: evaluateCameraBasis(camera.pose).forward,
        ...depthEffectSettingsFromCameraOptics(camera.optics, composition.width, width),
        transparencyTier: this.#auxiliary.depthOfFieldTier,
      });
    }
  }

  encode(
    encoder: GPUCommandEncoder,
    vertexBuffer: GPUBuffer,
    geometry: GeometryResult,
    mediaBindGroup: AuxiliaryEncodeRequest["mediaBindGroup"],
    generators: AuxiliaryEncodeRequest["generators"],
  ): void {
    if (!this.#enabled || !this.#source) return;
    if (
      !this.#auxiliary.encode({
        encoder,
        vertexBuffer,
        vertexCount: geometry.data.length / FLOATS_PER_VERTEX,
        batches: geometry.batches,
        motionVectors: this.#motionVectors,
        mediaBindGroup,
        generators: this.#motionSettings ? [] : generators,
      })
    )
      throw new Error("Nested camera auxiliary rendering failed");
    let result: GPUTexture | undefined;
    if (this.#motionSettings) {
      if (!this.#motion.encode(encoder, this.#motionSettings))
        throw new Error("Nested motion blur rendering failed");
      result = this.#motion.outputTexture;
    }
    if (this.#depthEnabled && this.#depthOutput) {
      const pass = encoder.beginRenderPass({
        label: "Nested scene-linear depth of field",
        colorAttachments: [
          {
            view: this.#depthOutput.createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      });
      const encoded = this.#depth.encode(pass, "depthOfField");
      pass.end();
      if (!encoded) throw new Error("Nested depth of field rendering failed");
      result = this.#depthOutput;
    }
    if (result)
      encoder.copyTextureToTexture({ texture: result }, { texture: this.#source }, [
        this.#width,
        this.#height,
      ]);
  }

  get estimatedBytes(): number {
    return (
      this.#auxiliary.estimatedBytes +
      this.#motion.estimatedBytes +
      (this.#depthOutput ? this.#width * this.#height * 8 : 0)
    );
  }
  destroy(): void {
    this.#auxiliary.destroy();
    this.#motion.destroy();
    this.#depth.destroy();
    this.#depthOutput?.destroy();
  }
}
