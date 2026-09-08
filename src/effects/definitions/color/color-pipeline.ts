import { angle, choice, color, number, percent, toggle } from "../../parameter-builders";
import type { EffectDefinition } from "../../types";

export const COLOR_PIPELINE_EFFECTS: EffectDefinition[] = [
  {
    type: "printer-lights",
    name: "Printer Lights",
    category: "Color Correction",
    description: "Adjust RGB and master exposure in repeatable photochemical printer-light points.",
    execution: "fused-pixel",
    parameters: [
      number("red", "Red Points", 0, -50, 50, 1),
      number("green", "Green Points", 0, -50, 50, 1),
      number("blue", "Blue Points", 0, -50, 50, 1),
      number("master", "Master Points", 0, -50, 50, 1),
      number("pointSize", "Exposure Per Point", 0.025, 0.001, 0.25, 0.001, "stops"),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "hue-vs-hue",
    name: "Hue vs Hue",
    category: "Color Correction",
    description:
      "Rotate a qualified hue range with circular falloff and no extra color-space pass.",
    execution: "fused-pixel",
    parameters: [
      angle("center", "Hue Center", 0),
      number("range", "Hue Range", 35, 0.1, 180, 0.5, "°"),
      angle("shift", "Hue Shift", 18),
      number("softness", "Softness", 0.12, 0, 1, 0.005),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "hue-vs-saturation",
    name: "Hue vs Saturation",
    category: "Color Correction",
    description: "Scale saturation inside a selected circular hue range.",
    execution: "fused-pixel",
    parameters: [
      angle("center", "Hue Center", 0),
      number("range", "Hue Range", 35, 0.1, 180, 0.5, "°"),
      number("saturation", "Saturation", 1.2, 0, 4, 0.01),
      number("softness", "Softness", 0.12, 0, 1, 0.005),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "luma-vs-saturation",
    name: "Luma vs Saturation",
    category: "Color Correction",
    description:
      "Shape saturation independently across shadow, midtone, and highlight luminance zones.",
    execution: "fused-pixel",
    parameters: [
      number("shadows", "Shadow Saturation", 0.75, 0, 4, 0.01),
      number("midtones", "Midtone Saturation", 1, 0, 4, 0.01),
      number("highlights", "Highlight Saturation", 0.85, 0, 4, 0.01),
      number("shadowEnd", "Shadow End", 0.28, 0.01, 1, 0.005),
      number("highlightStart", "Highlight Start", 0.68, 0, 0.99, 0.005),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "shadow-desaturate",
    name: "Shadow Desaturate",
    category: "Color Correction",
    description: "Suppress noisy low-light chroma with a soft scene-linear luminance key.",
    execution: "fused-pixel",
    parameters: [
      number("threshold", "Shadow Threshold", 0.22, 0, 4, 0.005),
      number("softness", "Softness", 0.14, 0, 2, 0.005),
      number("saturation", "Shadow Saturation", 0.35, 0, 4, 0.01),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "highlight-tint",
    name: "Highlight Tint",
    category: "Color Correction",
    description:
      "Tint scene-linear highlights with luminance preservation and a soft shoulder key.",
    execution: "fused-pixel",
    parameters: [
      number("threshold", "Highlight Threshold", 0.72, 0, 8, 0.005),
      number("softness", "Softness", 0.18, 0, 4, 0.005),
      color("color", "Tint Color", 0xffc27c),
      percent("amount", "Amount", 28),
      toggle("preserveLuminance", "Preserve Luminance", 1),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "filmic-tone-map",
    name: "Filmic Tone Map",
    category: "Color Correction",
    description:
      "Map HDR through ACES, Hable, or Reinhard curves with creative toe and shoulder control.",
    execution: "fused-pixel",
    parameters: [
      choice("curve", "Curve", ["ACES", "Hable", "Reinhard"]),
      number("exposure", "Exposure", 0, -10, 10, 0.05, "EV"),
      number("whitePoint", "White Point", 4, 0.1, 32, 0.1),
      number("toe", "Toe", 0.08, 0, 1, 0.01),
      number("shoulder", "Shoulder", 0.18, 0, 2, 0.01),
      number("saturation", "Saturation", 1, 0, 4, 0.01),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "skin-tone-refine",
    name: "Skin Tone Refine",
    category: "Color Correction",
    description: "Qualify skin-like hues for subtle warmth, saturation, and lightness refinement.",
    execution: "fused-pixel",
    parameters: [
      angle("center", "Skin Hue", 32),
      number("range", "Hue Range", 28, 0.1, 120, 0.5, "°"),
      number("softness", "Softness", 0.16, 0, 1, 0.005),
      number("saturation", "Saturation", 1.04, 0, 4, 0.01),
      number("lightness", "Lightness", 0.015, -1, 1, 0.005),
      number("warmth", "Warmth", 0.035, -1, 1, 0.005),
      percent("blend", "Blend", 100),
    ],
  },
];
