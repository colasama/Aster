import { angle, choice, color, number, percent } from "./parameter-builders";
import type { EffectDefinition } from "./types";

export const QC_OVERLAY_EFFECTS: EffectDefinition[] = [
  {
    type: "zebra-overlay",
    name: "Zebra Overlay",
    category: "Utility",
    description:
      "Mark highlights above a scene-linear threshold with configurable diagonal stripes.",
    execution: "fused-pixel",
    parameters: [
      number("threshold", "Exposure Threshold", 0.82, 0, 16, 0.01),
      number("spacing", "Stripe Spacing", 16, 2, 256, 1, "px"),
      angle("angle", "Stripe Angle", 45),
      color("color", "Overlay Color", 0xffd52a),
      percent("opacity", "Opacity", 75),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "gamut-warning",
    name: "Gamut Warning",
    category: "Utility",
    description:
      "Highlight negative, clipped, or excessive-chroma values against a target display gamut.",
    execution: "fused-pixel",
    parameters: [
      choice("gamut", "Target Gamut", ["Rec.709", "Display P3", "HDR Extended"]),
      number("limit", "Channel Limit", 1, 0.1, 16, 0.01),
      number("chromaLimit", "Chroma Limit", 0.82, 0.1, 8, 0.01),
      color("color", "Warning Color", 0xff00ff),
      percent("opacity", "Opacity", 80),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "focus-peaking",
    name: "Focus Peaking",
    category: "Utility",
    description: "Overlay high-frequency focus edges using a fixed four-sample gradient.",
    execution: "fused-pixel",
    parameters: [
      number("radius", "Sample Radius", 1.5, 0.25, 32, 0.25, "px"),
      number("threshold", "Edge Threshold", 0.08, 0, 4, 0.005),
      color("color", "Peaking Color", 0x00e5ff),
      percent("opacity", "Opacity", 90),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "alpha-boundary",
    name: "Alpha Boundary",
    category: "Utility",
    description: "Visualize translucent matte boundaries with a color-coded GPU edge overlay.",
    execution: "fused-pixel",
    parameters: [
      number("radius", "Edge Radius", 2, 0.25, 64, 0.25, "px"),
      number("threshold", "Edge Threshold", 0.05, 0, 1, 0.005),
      color("color", "Boundary Color", 0x39ff88),
      percent("opacity", "Opacity", 90),
      percent("blend", "Blend", 100),
    ],
  },
];
