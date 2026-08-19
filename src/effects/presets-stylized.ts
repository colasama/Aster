import type { EffectPreset } from "./presets";

export const STYLIZED_LOOK_PRESETS: EffectPreset[] = [
  {
    id: "crt-broadcast",
    name: "CRT Broadcast",
    description: "RGB phosphor triads, raster scanlines, and a compact broadcast display shoulder.",
    palette: ["#11141c", "#486ba5", "#d5e7e8"],
    effects: [
      {
        type: "rgb-phosphor",
        parameters: { pitch: 3, maskStrength: 72, scanline: 26, colorBleed: 1.6 },
      },
      { type: "scanlines", parameters: { spacing: 4, width: 1, intensity: 24 } },
      {
        type: "filmic-tone-map",
        parameters: { curve: 2, whitePoint: 2.2, toe: 0.12, shoulder: 0.24 },
      },
    ],
  },
  {
    id: "damaged-16mm",
    name: "Damaged 16mm",
    description:
      "Warm small-gauge stock with gate instability, dust, scratches, and exposure flicker.",
    palette: ["#2a1e16", "#9f7047", "#e7c28b"],
    effects: [
      {
        type: "film-emulation",
        parameters: { stock: 0, strength: 0.72, grain: 0.12, halation: 0.09 },
      },
      {
        type: "gate-weave",
        parameters: { horizontal: 5, vertical: 3, rotation: 0.12, speed: 2.4 },
      },
      {
        type: "film-damage",
        parameters: { scratches: 34, dust: 28, flicker: 16, speed: 14, seed: 17 },
      },
    ],
  },
  {
    id: "security-tape",
    name: "Security Tape",
    description: "Low-chroma surveillance response with tape dropouts and unstable head switching.",
    palette: ["#101719", "#556769", "#c1c9c4"],
    effects: [
      { type: "black-white", parameters: { reds: 0.26, greens: 0.62, blues: 0.12 } },
      {
        type: "tape-dropout",
        parameters: { density: 25, length: 620, height: 3, speed: 18, seed: 43 },
      },
      { type: "head-switching", parameters: { height: 14, amount: 96, speed: 0.7, softness: 18 } },
      {
        type: "looks-color-lab",
        parameters: { contrast: 1.18, lift: 0.025, gain: 0.88, grain: 0.06 },
      },
    ],
  },
  {
    id: "pixel-corruption",
    name: "Pixel Corruption",
    description:
      "Codec macroblocks, qualified pixel sorting, and sharp digital channel separation.",
    palette: ["#111536", "#00a4bc", "#ff3f91"],
    effects: [
      {
        type: "compression-blocks",
        parameters: { blockSize: 18, quality: 28, chromaLoss: 44, ringing: 34 },
      },
      { type: "pixel-sort", parameters: { threshold: 0.36, length: 96, direction: 0, reverse: 0 } },
      { type: "chromatic", parameters: { amount: 11, angle: 0, falloff: 0.25 } },
    ],
  },
  {
    id: "immersive-night",
    name: "Immersive Night",
    description:
      "Deep spherical blue-to-violet density with HDR panorama glow and protected highlights.",
    palette: ["#061028", "#293c9b", "#cb73d7"],
    effects: [
      {
        type: "vr-color-gradients",
        parameters: { northColor: 0x172b7a, southColor: 0x7e285e, rotation: 8, intensity: 0.42 },
      },
      { type: "vr-glow", parameters: { threshold: 0.64, radius: 26, intensity: 1.05 } },
      { type: "highlight-recovery", parameters: { threshold: 0.7, strength: 78, rolloff: 3.6 } },
    ],
  },
  {
    id: "faded-television",
    name: "Faded Television",
    description: "Soft analog contrast, coarse raster texture, and low-quality chroma compression.",
    palette: ["#353241", "#8c7b88", "#d2c6ae"],
    effects: [
      {
        type: "compression-blocks",
        parameters: { blockSize: 12, quality: 52, chromaLoss: 68, ringing: 12 },
      },
      { type: "scanlines", parameters: { spacing: 5, width: 1.4, intensity: 18, phase: 0.5 } },
      {
        type: "looks-color-lab",
        parameters: { contrast: 0.86, lift: 0.05, gain: 0.9, fade: 0.16, saturation: 0.72 },
      },
    ],
  },
  {
    id: "neon-phosphor",
    name: "Neon Phosphor",
    description: "Electric phosphor color, selective saturation, and a broad neon highlight bloom.",
    palette: ["#0b1648", "#08c7d9", "#e538ad"],
    effects: [
      {
        type: "rgb-phosphor",
        parameters: { pitch: 2, maskStrength: 46, scanline: 10, colorBleed: 2.2 },
      },
      {
        type: "hue-vs-saturation",
        parameters: { center: 300, range: 72, saturation: 1.42, softness: 0.18 },
      },
      { type: "glow", parameters: { threshold: 0.56, radius: 58, intensity: 0.82 } },
    ],
  },
  {
    id: "archive-newsreel",
    name: "Archive Newsreel",
    description: "Hard monochrome news stock with film dirt, weave, flicker, and silver grain.",
    palette: ["#0c0d0d", "#77756e", "#e0d9c5"],
    effects: [
      { type: "black-white", parameters: { reds: 0.34, greens: 0.54, blues: 0.12 } },
      {
        type: "film-damage",
        parameters: { scratches: 30, dust: 24, flicker: 18, speed: 16, seed: 101 },
      },
      {
        type: "gate-weave",
        parameters: { horizontal: 3.5, vertical: 2.5, rotation: 0.08, speed: 3 },
      },
      {
        type: "add-grain",
        parameters: { intensity: 20, size: 1.4, softness: 0.12, colorAmount: 0 },
      },
      { type: "looks-color-lab", parameters: { contrast: 1.3, pivot: 0.38, vignette: 0.28 } },
    ],
  },
];
