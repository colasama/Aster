import type {
  NativeExportDecision,
  NativeFramePacket,
} from "../../core/rendering/native-export-protocol";
import { frameTimeAtIndex } from "../../core/rendering/render-export";
import type { RenderHostFrameLoopOptions } from "./render-host-session";

type PreparedFrame = { ok: true; packet: NativeFramePacket } | { ok: false; error: unknown };

export async function preflightNativeRenderHost(options: RenderHostFrameLoopOptions): Promise<{
  active: boolean;
  prepared: boolean;
  cancelled: boolean;
}> {
  const manifest = options.assignment.manifest;
  const outputId = manifest.outputs[0]?.id;
  const unavailable = { active: false, prepared: false, cancelled: false };
  if (!options.planFrame || !outputId) return unavailable;
  const shared = {
    jobId: options.assignment.assignment.jobId,
    leaseId: options.assignment.assignment.leaseId,
    outputId,
  };
  const accepted = (value: unknown): boolean => {
    const decision = value as NativeExportDecision | undefined;
    if (
      typeof decision?.accepted !== "boolean" ||
      (decision.accepted
        ? decision.reason !== null
        : typeof decision.reason !== "string" || !decision.reason)
    )
      throw new Error("Native preflight returned an invalid decision");
    return decision.accepted;
  };
  if (!accepted(await options.output({ type: "prepareNative", ...shared }))) return unavailable;
  const reportIdentity = { jobId: shared.jobId, leaseId: shared.leaseId };
  if (options.requestedControl() === "cancel") return { ...unavailable, cancelled: true };
  await options.report({ type: "prepared", ...reportIdentity });
  const result = { active: false, prepared: true, cancelled: false };
  const boundary = async () => {
    if (options.requestedControl() === "pause") {
      await options.report({ type: "paused", ...reportIdentity });
      while (true) {
        const changed = options.waitForControlChange?.();
        if (options.requestedControl() !== "pause") break;
        if (!changed) throw new Error("Native preflight pause requires a control signal");
        await changed;
      }
    }
    return options.requestedControl() !== "cancel";
  };
  const planFrame = options.planFrame;
  const capture = async (index: number, resources: ReadonlySet<string>): Promise<PreparedFrame> => {
    try {
      const frame = manifest.startFrame + index;
      return {
        ok: true,
        packet: await planFrame(frame, frameTimeAtIndex(frame, manifest.frameRate), resources),
      };
    } catch (error) {
      return { ok: false, error };
    }
  };
  let prepared: PreparedFrame | undefined;
  let retained = new Set<string>();
  const frameCount = manifest.endFrameExclusive - manifest.startFrame;
  for (let index = 0; index < frameCount; index++) {
    if (!(await boundary())) return { ...result, cancelled: true };
    prepared ??= await capture(index, retained);
    if (!prepared.ok) {
      if (options.requestedControl() === "cancel") return { ...result, cancelled: true };
      const error = prepared.error;
      await options.output({
        type: "abandonNative",
        ...shared,
        reason:
          `Native frame preparation: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            2048,
          ),
      });
      return result;
    }
    if (!(await boundary())) return { ...result, cancelled: true };
    // One owned packet can be prepared while the prior packet is admitted by Rust. Never
    // start another capture or control operation until both lanes settle, including failures.
    const packet = prepared.packet;
    const references = packet.resources.filter((resource) => retained.has(resource.message.hash));
    const admission = options.output({
      type: "admitNative",
      ...shared,
      frame: index,
      packet: references.length
        ? {
            plan: packet.plan,
            resources: packet.resources.filter((resource) => !retained.has(resource.message.hash)),
            retainedResources: [
              ...(packet.retainedResources ?? []),
              ...references.map((resource) => resource.message.hash),
            ],
          }
        : packet,
    });
    const nextRetained = new Set([
      ...packet.resources.map((resource) => resource.message.hash),
      ...(packet.retainedResources ?? []),
    ]);
    // The next packet may omit these bytes while capture overlaps admission. It is never
    // submitted unless this admission succeeds; failure or cancellation discards it.
    const ahead =
      index + 1 < frameCount && !options.requestedControl()
        ? capture(index + 1, nextRetained)
        : undefined;
    const [admitted, next] = await Promise.allSettled([admission, ahead]);
    if (options.requestedControl() === "cancel") return { ...result, cancelled: true };
    if (admitted.status === "rejected") throw admitted.reason;
    if (!accepted(admitted.value)) return result;
    retained = nextRetained;
    if (next.status === "rejected") throw next.reason;
    prepared = next.value;
  }
  if (!(await boundary())) return { ...result, cancelled: true };
  return { ...result, active: accepted(await options.output({ type: "sealNative", ...shared })) };
}
