import { choice, color, number, percent, toggle } from "./parameter-builders";
import type { EffectDefinition } from "./types";

export const AE_KEYING_CLEANUP_EFFECTS: EffectDefinition[] = [
  {
    type: "key-cleaner",
    name: "Key Cleaner",
    category: "Keying",
    description:
      "Stabilize keyed edges with local matte averaging, contrast, and chatter reduction.",
    execution: "fused-pixel",
    parameters: [
      number("radius", "Additional Edge Radius", 2, 0.25, 128, 0.25, "px"),
      percent("strength", "Strength", 75),
      number("contrast", "Matte Contrast", 1.15, 0.1, 8, 0.01),
      percent("reduceChatter", "Reduce Chatter", 65),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "screen-matte",
    name: "Screen Matte",
    category: "Keying",
    description: "Clip, reshape, and invert a screen matte in one ordered GPU operation.",
    execution: "fused-pixel",
    parameters: [
      number("clipBlack", "Clip Black", 0.04, 0, 1, 0.005),
      number("clipWhite", "Clip White", 0.94, 0, 1, 0.005),
      number("gamma", "Gamma", 1, 0.05, 10, 0.01),
      number("shrinkGrow", "Shrink / Grow", 0, -128, 128, 0.25, "px"),
      number("softness", "Softness", 1, 0, 64, 0.25, "px"),
      toggle("invert", "Invert Matte", 0),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "core-matte",
    name: "Core Matte",
    category: "Keying",
    description: "Fill the opaque core of a key while preserving its translucent boundary.",
    execution: "fused-pixel",
    parameters: [
      number("radius", "Core Radius", 5, 0.25, 256, 0.25, "px"),
      number("threshold", "Core Threshold", 0.72, 0, 1, 0.005),
      number("softness", "Softness", 0.08, 0, 1, 0.005),
      percent("density", "Core Density", 100),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "despot",
    name: "Despot",
    category: "Keying",
    description:
      "Fill isolated matte holes or remove isolated opaque specks with a bounded neighborhood.",
    execution: "fused-pixel",
    parameters: [
      number("radius", "Radius", 3, 0.25, 128, 0.25, "px"),
      number("threshold", "Threshold", 0.5, 0, 1, 0.005),
      choice("mode", "Mode", ["Fill Holes", "Remove Dots"]),
      percent("strength", "Strength", 100),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "edge-extend",
    name: "Edge Extend",
    category: "Matte",
    description:
      "Extend neighboring opaque color into transparent edge pixels to prevent dark fringes.",
    execution: "fused-pixel",
    parameters: [
      number("radius", "Extend Radius", 3, 0.25, 128, 0.25, "px"),
      percent("strength", "Strength", 100),
      number("alphaThreshold", "Alpha Threshold", 0.18, 0, 1, 0.005),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "edge-color-blend",
    name: "Edge Color Blend",
    category: "Matte",
    description:
      "Blend local source color across the translucent matte boundary with luminance protection.",
    execution: "fused-pixel",
    parameters: [
      number("radius", "Blend Radius", 4, 0.25, 128, 0.25, "px"),
      percent("amount", "Amount", 70),
      toggle("preserveLuminance", "Preserve Luminance", 1),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "spill-killer",
    name: "Spill Killer",
    category: "Keying",
    description: "Remove a selected screen-color projection while preserving edge luminance.",
    execution: "fused-pixel",
    parameters: [
      color("screenColor", "Screen Color", 0x00c878),
      percent("amount", "Suppression", 85),
      number("balance", "Color Balance", 0.5, 0, 1, 0.01),
      number("range", "Range", 0.12, 0, 1, 0.005),
      toggle("preserveLuminance", "Preserve Luminance", 1),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "wire-removal",
    name: "CC Simple Wire Removal",
    category: "Keying",
    description: "Replace a feathered line segment with samples taken from both sides of the wire.",
    execution: "fused-pixel",
    parameters: [
      percent("startX", "Start X", 40),
      percent("startY", "Start Y", 20),
      percent("endX", "End X", 60),
      percent("endY", "End Y", 80),
      number("width", "Wire Width", 8, 0.25, 256, 0.25, "px"),
      number("feather", "Feather", 4, 0, 128, 0.25, "px"),
      number("sampleOffset", "Sample Offset", 14, 0.5, 512, 0.5, "px"),
      percent("blend", "Blend", 100),
    ],
  },
];
