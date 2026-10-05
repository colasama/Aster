import type { Layer } from "../../core/types";
import { requirePlan } from "../frame-plan/canonical";
import { prepareLutTexture } from "./lut-texture";

export type LutSelection =
  | { status: "ready"; resource: ReturnType<typeof prepareLutTexture> }
  | { status: "failed"; error: string };

/** Preserve source-key invalidation while owning the pixels consumed by later execution. */
export class LutSelectionPlanner {
  readonly identity = prepareLutTexture();
  readonly #entries = new Map<string, { key: string; selection: LutSelection }>();

  prepare(instanceId: string, layer: Layer): LutSelection {
    const lut = [...layer.effects]
      .reverse()
      .find((effect) => effect.enabled && effect.type === "lut" && effect.resource)?.resource;
    const key = lut ? `${lut.checksum}:${lut.size}` : "identity";
    const existing = this.#entries.get(instanceId);
    if (existing?.key === key) return existing.selection;
    try {
      const selection: LutSelection = {
        status: "ready",
        resource: lut ? prepareLutTexture(lut) : this.identity,
      };
      this.#entries.set(instanceId, { key, selection });
      return selection;
    } catch (error) {
      // Keep adjustment-layer failures at the existing execution diagnostic boundary.
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  sweep(active: ReadonlySet<string>): void {
    for (const instanceId of this.#entries.keys()) {
      if (!active.has(instanceId)) this.#entries.delete(instanceId);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}

export function suppliedLutResource(selection: LutSelection | undefined) {
  requirePlan(selection, "missing_resource", "Missing prepared LUT selection");
  if (selection.status === "failed") throw new Error(selection.error);
  const { message } = selection.resource;
  requirePlan(
    message.kind === "texture_pixels" &&
      "dimension" in message.descriptor &&
      message.descriptor.dimension === "3d" &&
      message.descriptor.format === "rgba16float" &&
      message.descriptor.width === message.descriptor.height &&
      message.descriptor.width === message.descriptor.depth,
    "invalid_resource",
    "LUT binding requires a cubic RGBA16F texture",
  );
  return selection.resource;
}
