// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RenderJobManifest } from "../src/core/rendering/render-queue";
import { buildFrameHeader } from "../src/renderer/frame-plan/root-post-plan";
import { validateNativeJobFrame } from "./native-job-identity";
import type { NativeSessionReply } from "./native-render-protocol";

const manifest = {
  id: "immutable-job",
  compositionId: "composition-😀-\ud800",
  projectRevision: 17,
  width: 320,
  height: 180,
  antiAliasing: "ssaa2x",
  startFrame: 100,
  endFrameExclusive: 110,
  frameRate: { numerator: 60000, denominator: 2002 },
} as RenderJobManifest;
const plan = Buffer.from("authenticated plan bytes");
function reply(): NativeSessionReply {
  return {
    version: 1,
    request_id: 1,
    payload_bytes: 0,
    payload: Buffer.alloc(0),
    response: {
      type: "frame_checked",
      plan_sha256: createHash("sha256").update(plan).digest("hex"),
      header: buildFrameHeader({
        snapshot: {
          snapshotScope: `render-job:${manifest.id}`,
          projectRevision: manifest.projectRevision,
        },
        compositionId: manifest.compositionId,
        time: (manifest.startFrame * manifest.frameRate.denominator) / manifest.frameRate.numerator,
        frameRate: manifest.frameRate,
        target: { width: 320, height: 180 },
        renderTarget: { width: 640, height: 360 },
        antiAliasing: "ssaa2x",
      }),
    },
  };
}
describe("native immutable job admission", () => {
  it("authenticates warm-up identity without treating it as encoded admission", () => {
    const warmed = reply();
    warmed.response = { type: "frame_warmed", frame: warmed.response };
    expect(() => validateNativeJobFrame(manifest, 0, plan, warmed, "warmup")).not.toThrow();
    expect(() => validateNativeJobFrame(manifest, 0, plan, warmed)).toThrow(/authenticate/);
    expect(() => validateNativeJobFrame(manifest, 0, plan, reply(), "warmup")).toThrow(
      /authenticate/,
    );
    expect(() => validateNativeJobFrame(manifest, 1, plan, warmed, "warmup")).toThrow(/time/);
  });
  it("accepts the production header including NTSC time, reduced rate and UTF-16 identity", () => {
    expect(() => validateNativeJobFrame(manifest, 0, plan, reply())).not.toThrow();
  });
  it.each([
    ["snapshot_scope", "render-job:another"],
    ["project_revision", 18],
    ["composition_id", "another"],
    ["target", { width: 640, height: 360 }],
    ["render_target", { width: 320, height: 180 }],
    ["aa", "off"],
    ["frame_rate", { kind: "rational", numerator: 30, denominator: 1 }],
    ["color_pipeline", "sdr"],
    ["extra", true],
    ["time", { kind: "binary_rational", negative: false, significand: 1, exponent: 0 }],
  ])("rejects a changed %s before replay", (key, value) => {
    const checked = reply();
    (checked.response.header as Record<string, unknown>)[key as string] = value;
    expect(() => validateNativeJobFrame(manifest, 0, plan, checked)).toThrow(/immutable job/);
  });
  it("rejects stale frame indices and unauthenticated plan bytes", () => {
    expect(() => validateNativeJobFrame(manifest, 1, plan, reply())).toThrow(/time/);
    expect(() => validateNativeJobFrame(manifest, 10, plan, reply())).toThrow(/index/);
    expect(() => validateNativeJobFrame(manifest, 0, Buffer.from("changed"), reply())).toThrow(
      /authenticate/,
    );
  });
  it("authenticates encoded admission without a second check/decode request", () => {
    const encoded = reply();
    const { type: _type, ...proof } = encoded.response;
    encoded.response = { type: "encoded", submitted_frame: 0, complete: false, frame: proof };
    expect(() => validateNativeJobFrame(manifest, 0, plan, encoded)).not.toThrow();
    for (const mutation of [
      { submitted_frame: 1 },
      { complete: true },
      { frame: undefined },
      { frame: { ...proof, plan_sha256: "0".repeat(64) } },
      { frame: { ...proof, header: { ...(proof.header as object), snapshot_scope: "another" } } },
    ])
      expect(() =>
        validateNativeJobFrame(manifest, 0, plan, {
          ...encoded,
          response: { ...encoded.response, ...mutation },
        }),
      ).toThrow();
  });
});
