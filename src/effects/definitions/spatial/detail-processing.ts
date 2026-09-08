import { angle, choice, number, percent } from "../../parameter-builders";
import type { EffectDefinition } from "../../types";

export const DETAIL_PROCESSING_EFFECTS: EffectDefinition[] = [
  {
    type: "detail-preserving-upscale",
    name: "Detail-preserving Upscale",
    category: "Blur & Sharpen",
    description:
      "Recover gated high-frequency detail after scaling without amplifying flat-field noise.",
    execution: "fused-pixel",
    parameters: [
      number("scale", "Scale Factor", 2, 1, 8, 0.1),
      percent("detail", "Detail", 60),
      number("noiseReduction", "Noise Reduction", 0.025, 0, 1, 0.005),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "reduce-interlace-flicker",
    name: "Reduce Interlace Flicker",
    category: "Blur & Sharpen",
    description: "Stabilize alternating scan-line detail with a vertical linear-light filter.",
    execution: "fused-pixel",
    parameters: [
      number("radius", "Vertical Radius", 1, 0.25, 16, 0.25, "px"),
      percent("strength", "Strength", 65),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "deband",
    name: "Deband",
    category: "Noise & Grain",
    description: "Smooth low-gradient bands and add deterministic sub-code-value dithering.",
    execution: "fused-pixel",
    parameters: [
      number("radius", "Radius", 6, 0.5, 128, 0.5, "px"),
      number("threshold", "Band Threshold", 0.018, 0, 1, 0.001),
      percent("dither", "Dither", 35),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "denoise",
    name: "Denoise",
    category: "Noise & Grain",
    description: "Apply a fixed-cost cross bilateral filter with controllable detail restoration.",
    execution: "fused-pixel",
    parameters: [
      number("radius", "Radius", 2, 0.5, 64, 0.5, "px"),
      number("threshold", "Edge Threshold", 0.08, 0.001, 2, 0.005),
      percent("strength", "Strength", 75),
      percent("preserveDetail", "Preserve Detail", 35),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "clarity",
    name: "Clarity",
    category: "Blur & Sharpen",
    description: "Boost midtone micro-contrast while protecting deep shadows and highlights.",
    execution: "fused-pixel",
    parameters: [
      number("radius", "Radius", 12, 1, 256, 1, "px"),
      number("amount", "Amount", 0.45, -2, 2, 0.01),
      percent("midtoneBias", "Midtone Bias", 70),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "local-contrast",
    name: "Local Contrast",
    category: "Blur & Sharpen",
    description:
      "Enhance thresholded local structure with highlight protection in scene-linear space.",
    execution: "fused-pixel",
    parameters: [
      number("radius", "Radius", 36, 1, 512, 1, "px"),
      number("amount", "Amount", 0.6, -4, 4, 0.01),
      number("threshold", "Threshold", 0.015, 0, 1, 0.001),
      percent("protectHighlights", "Protect Highlights", 65),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "smart-sharpen",
    name: "Smart Sharpen",
    category: "Blur & Sharpen",
    description: "Sharpen thresholded detail using Gaussian, lens, or directional removal models.",
    execution: "fused-pixel",
    parameters: [
      number("radius", "Radius", 1.4, 0.25, 64, 0.25, "px"),
      percent("amount", "Amount", 90),
      number("threshold", "Threshold", 0.025, 0, 1, 0.005),
      choice("remove", "Remove", ["Gaussian Blur", "Lens Blur", "Motion Blur"]),
      angle("angle", "Motion Angle", 0),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "frequency-separation",
    name: "Frequency Separation",
    category: "Blur & Sharpen",
    description: "Preview low frequency, high frequency, or detail-adjusted recombination.",
    execution: "fused-pixel",
    parameters: [
      number("radius", "Separation Radius", 8, 0.5, 256, 0.5, "px"),
      choice("view", "View", ["Low Frequency", "High Frequency", "Recombined"], 2),
      number("detail", "High Detail Gain", 1, 0, 4, 0.01),
      percent("blend", "Blend", 100),
    ],
  },
];
