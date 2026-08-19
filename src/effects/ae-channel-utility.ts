import { choice, color, number, percent, toggle } from "./parameter-builders";
import type { EffectDefinition } from "./types";

const MATTE_CHANNELS = ["Red", "Green", "Blue", "Luminance", "Alpha", "Full On", "Full Off"];

export const AE_CHANNEL_UTILITY_EFFECTS: EffectDefinition[] = [
  {
    type: "shift-channels",
    name: "Shift Channels",
    category: "Channel",
    description: "Replace alpha from any source channel while optionally preserving straight RGB.",
    execution: "fused-pixel",
    parameters: [
      choice("alphaSource", "Take Alpha From", MATTE_CHANNELS, 4),
      toggle("invert", "Invert Alpha", 0),
      toggle("preserveRgb", "Preserve Straight RGB", 1),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "channel-combiner",
    name: "Channel Combiner",
    category: "Channel",
    description: "Convert RGB and YCbCr component encodings or inspect luminance and chroma.",
    execution: "fused-pixel",
    parameters: [
      choice("operation", "Operation", ["RGB to YCbCr", "YCbCr to RGB", "Luminance / Chroma"]),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "solid-composite",
    name: "Solid Composite",
    category: "Channel",
    description: "Composite the source over a solid linear-light background using straight alpha.",
    execution: "fused-pixel",
    parameters: [
      color("color", "Background Color", 0x101521),
      percent("opacity", "Background Opacity", 100),
    ],
  },
  {
    type: "premultiply-color",
    name: "Premultiply Color",
    category: "Channel",
    description: "Multiply straight RGB by alpha for explicit matte pipeline control.",
    execution: "fused-pixel",
    parameters: [percent("amount", "Amount", 100)],
  },
  {
    type: "unpremultiply-color",
    name: "Unpremultiply Color",
    category: "Channel",
    description: "Recover straight RGB with a bounded alpha floor to avoid edge instability.",
    execution: "fused-pixel",
    parameters: [
      number("alphaFloor", "Alpha Floor", 0.01, 0.0001, 1, 0.001),
      percent("amount", "Amount", 100),
    ],
  },
  {
    type: "alpha-from-luminance",
    name: "Alpha From Luminance",
    category: "Channel",
    description:
      "Derive alpha from HDR luminance with levels, gamma, inversion, and combine modes.",
    execution: "fused-pixel",
    parameters: [
      number("black", "Input Black", 0, 0, 8, 0.005),
      number("white", "Input White", 1, 0, 16, 0.005),
      number("gamma", "Gamma", 1, 0.05, 10, 0.01),
      toggle("invert", "Invert Matte", 0),
      choice("combine", "Combine", ["Replace", "Multiply", "Maximum"]),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "set-matte",
    name: "Set Matte",
    category: "Matte",
    description:
      "Build a soft matte from a selected channel without leaving the ordered GPU chain.",
    execution: "fused-pixel",
    parameters: [
      choice("channel", "Use For Matte", MATTE_CHANNELS, 3),
      number("threshold", "Threshold", 0.5, 0, 8, 0.005),
      number("softness", "Softness", 0.1, 0, 4, 0.005),
      toggle("invert", "Invert Matte", 0),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "hdr-clamp",
    name: "HDR Clamp",
    category: "Color Correction",
    description: "Bound scene-linear values with a soft knee and optional luminance-only limiting.",
    execution: "fused-pixel",
    parameters: [
      number("minimum", "Minimum", 0, -8, 8, 0.01),
      number("maximum", "Maximum", 1, -8, 32, 0.01),
      number("softKnee", "Soft Knee", 0.1, 0, 8, 0.005),
      toggle("luminanceOnly", "Luminance Only", 0),
      percent("blend", "Blend", 100),
    ],
  },
];
