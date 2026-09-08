import { angle, choice, number, percent, toggle } from "./parameter-builders";
import type { EffectDefinition } from "./types";

export const BLUR_SHARPEN_EFFECTS: EffectDefinition[] = [
  {
    type: "channel-blur",
    name: "Channel Blur",
    category: "Blur & Sharpen",
    description: "Blur red, green, blue, and alpha channels independently on the GPU.",
    execution: "multi-pass",
    parameters: [
      number("red", "Red Blurriness", 8, 0, 500, 0.5, "px"),
      number("green", "Green Blurriness", 8, 0, 500, 0.5, "px"),
      number("blue", "Blue Blurriness", 8, 0, 500, 0.5, "px"),
      number("alpha", "Alpha Blurriness", 0, 0, 500, 0.5, "px"),
    ],
  },
  {
    type: "cross-blur",
    name: "Cross Blur",
    category: "Blur & Sharpen",
    description: "Fast separable cross-kernel blur with independent horizontal and vertical radii.",
    execution: "fused-pixel",
    parameters: [
      number("horizontal", "Horizontal Radius", 18, 0, 1000, 0.5, "px"),
      number("vertical", "Vertical Radius", 18, 0, 1000, 0.5, "px"),
      percent("blend", "Blend With Original", 100),
    ],
  },
  {
    type: "smart-blur",
    name: "Smart Blur",
    category: "Blur & Sharpen",
    description: "Edge-preserving blur with normal, edge-only, and overlay result modes.",
    execution: "multi-pass",
    parameters: [
      number("radius", "Radius", 14, 0, 500, 0.5, "px"),
      number("threshold", "Threshold", 0.12, 0, 1, 0.005),
      choice("mode", "Mode", ["Normal", "Edge Only", "Overlay Edge"]),
      percent("blend", "Blend With Original", 100),
    ],
  },
  {
    type: "vector-blur",
    name: "CC Vector Blur",
    category: "Blur & Sharpen",
    description: "Blur along the local gradient field derived from a selected source channel.",
    execution: "multi-pass",
    parameters: [
      number("amount", "Amount", 24, -500, 500, 0.5, "px"),
      angle("angleBias", "Angle Offset", 0),
      choice("map", "Vector Map", ["Luminance", "Red", "Green", "Blue"]),
      percent("blend", "Blend With Original", 100),
    ],
  },
  {
    type: "radial-fast-blur",
    name: "CC Radial Fast Blur",
    category: "Blur & Sharpen",
    description: "Constant-cost spin or zoom blur around a movable center point.",
    execution: "fused-pixel",
    parameters: [
      percent("centerX", "Center X", 50),
      percent("centerY", "Center Y", 50),
      number("amount", "Amount", 18, -100, 100, 0.5),
      choice("mode", "Type", ["Zoom", "Spin"]),
      percent("blend", "Blend With Original", 100),
    ],
  },
  {
    type: "high-pass",
    name: "High Pass",
    category: "Blur & Sharpen",
    description:
      "Extract high-frequency detail for sharpening, texture, and compositing workflows.",
    execution: "multi-pass",
    parameters: [
      number("radius", "Radius", 8, 0.25, 500, 0.25, "px"),
      number("contrast", "Detail Contrast", 1, 0, 8, 0.05),
      toggle("monochrome", "Monochrome", 0),
      percent("blend", "Blend With Original", 100),
    ],
  },
  {
    type: "sharpen-edges",
    name: "Sharpen Edges",
    category: "Blur & Sharpen",
    description: "Thresholded Laplacian edge sharpening with a controllable sample radius.",
    execution: "fused-pixel",
    parameters: [
      percent("amount", "Amount", 80),
      number("radius", "Radius", 1.5, 0.25, 64, 0.25, "px"),
      number("threshold", "Threshold", 0.03, 0, 1, 0.005),
      percent("blend", "Blend With Original", 100),
    ],
  },
  {
    type: "compound-blur",
    name: "Compound Blur",
    category: "Blur & Sharpen",
    description: "Modulate blur radius per pixel from a selected source channel.",
    execution: "multi-pass",
    parameters: [
      number("maximumRadius", "Maximum Blur", 36, 0, 1000, 0.5, "px"),
      choice("map", "Blur Map", ["Luminance", "Red", "Green", "Blue", "Alpha"]),
      toggle("invert", "Invert Blur Map", 0),
      number("stretch", "Map Contrast", 1, 0.1, 8, 0.05),
      percent("blend", "Blend With Original", 100),
    ],
  },
];
