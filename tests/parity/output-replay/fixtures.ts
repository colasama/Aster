import { DEFAULT_MOTION_BLUR_SETTINGS } from "../../../src/core/animation/motion-blur";
import type { AntiAliasingMode } from "../../../src/core/rendering/anti-aliasing";
import { buildFrameHeader } from "../../../src/renderer/frame-plan/root-post-plan";
import type { BufferVisualization } from "../../../src/renderer/gpu/render-buffers";

export type Attachment = { role: string; format: GPUTextureFormat; bpp: number; bytes: number[] };
export const motionSettings = {
  ...DEFAULT_MOTION_BLUR_SETTINGS,
  enabled: true,
  framePosition: 0.5,
  maximumRadius: 256,
};
export const depthSettings = {
  fogDensity: 0.1,
  fogStart: 0,
  focusDistance: 8,
  aperture: 24,
  zoom: 64,
  maximumBlurRadius: 12,
  sampleCount: 16,
  transparencyTier: 2,
};
export function outputFixtures() {
  const cases: {
    id: string;
    mode: BufferVisualization;
    aa: AntiAliasingMode;
    motion: boolean;
    tier: number;
  }[] = [];
  for (const mode of [
    "beauty",
    "linearColor",
    "luminance",
    "alpha",
    "normal",
    "objectId",
    "materialId",
    "worldPosition",
    "motionVector",
    "depthFog",
    "depthOfField",
    "selectionIsolation",
    "vectorMotionBlur",
  ] as const)
    cases.push({ id: mode, mode, aa: "off", motion: false, tier: 2 });
  for (const aa of ["off", "fxaa", "ssaa2x", "ssaa4x"] as const)
    for (const mode of ["beauty", "depthOfField"] as const)
      cases.push({ id: `motion-${mode}-${aa}`, mode, aa, motion: true, tier: 2 });
  for (const tier of [0, 1])
    cases.push({ id: `depth-tier${tier}`, mode: "depthOfField", aa: "off", motion: true, tier });
  return cases.map((c) => {
    const scale = c.aa === "ssaa4x" ? 4 : c.aa === "ssaa2x" ? 2 : 1;
    const header = buildFrameHeader({
      snapshot: { snapshotScope: "output-replay", projectRevision: 1 },
      compositionId: "output",
      time: 1.25,
      frameRate: { numerator: 30, denominator: 1 },
      target: { width: 64, height: 48 },
      renderTarget: { width: 64 * scale, height: 48 * scale },
      antiAliasing: c.aa,
    });
    return {
      ...c,
      header,
      attachments: attachments(header.render_target.width, header.render_target.height, c.tier),
    };
  });
}
function half(n: number): number {
  if (!n) return 0;
  const sign = n < 0 ? 0x8000 : 0,
    a = Math.abs(n),
    exponent = Math.floor(Math.log2(a));
  return sign | ((exponent + 15) << 10) | Math.round((a / 2 ** exponent - 1) * 1024);
}
function attachments(width: number, height: number, tier: number): Attachment[] {
  return [
    "scene",
    "normal",
    "objectId",
    "materialId",
    "worldPosition",
    "motionVector",
    ...(tier > 0 ? ["transparentWorldPosition", "frontLayerColor"] : []),
    ...(tier > 1 ? ["peeledWorldPosition", "peeledLayerColor"] : []),
  ].map((role) => {
    const integer = role === "objectId" || role === "materialId",
      channels = integer ? 1 : role === "motionVector" ? 2 : 4;
    const data = new ArrayBuffer(width * height * channels * (integer ? 4 : 2)),
      view = new DataView(data);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const left = x < width / 2,
          checker = ((Math.floor(x / 5) + Math.floor(y / 7)) & 1) === 0;
        let values = [checker ? 2 : 0.125, left ? 0.25 : 1, checker ? 0.5 : 0.0625, left ? 1 : 0.5];
        if (role === "normal") values = [left ? 1 : 0, 0, left ? 0 : 1, 1];
        if (role.endsWith("WorldPosition") || role === "worldPosition")
          values = [
            left ? -4 : 4,
            y < height / 2 ? -2 : 2,
            role === "peeledWorldPosition"
              ? 32
              : role === "transparentWorldPosition"
                ? 16
                : left
                  ? 4
                  : 24,
            1,
          ];
        if (role === "motionVector") values = [left ? 0.125 : -0.0625, 0.03125];
        if (role === "objectId") values = [left ? 17 : 29];
        if (role === "materialId") values = [left ? 3 : 7];
        if (role === "frontLayerColor") values = [0.25, 0.125, 0.0625, 0.5];
        if (role === "peeledLayerColor") values = [0.0625, 0.125, 0.25, 0.5];
        for (let k = 0; k < channels; k++) {
          const offset = ((y * width + x) * channels + k) * (integer ? 4 : 2);
          if (integer) view.setUint32(offset, values[k], true);
          else view.setUint16(offset, half(values[k]), true);
        }
      }
    return {
      role,
      format: integer ? "r32uint" : channels === 2 ? "rg16float" : "rgba16float",
      bpp: channels * (integer ? 4 : 2),
      bytes: Array.from(new Uint8Array(data)),
    };
  });
}
