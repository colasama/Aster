import { choice, color, number, percent, toggle } from "./parameter-builders";
import type { EffectDefinition } from "./types";

export const FRAMING_EFFECTS: EffectDefinition[] = [
  {
    type: "crop",
    name: "Crop",
    category: "Transform",
    description: "Crop each edge independently with feathered alpha and optional inversion.",
    execution: "fused-pixel",
    parameters: [
      percent("left", "Left", 0),
      percent("right", "Right", 0),
      percent("top", "Top", 0),
      percent("bottom", "Bottom", 0),
      number("feather", "Edge Feather", 0, 0, 512, 0.25, "px"),
      toggle("invert", "Invert Crop", 0),
    ],
  },
  {
    type: "letterbox",
    name: "Letterbox",
    category: "Transform",
    description: "Apply a centered cinematic matte for standard or custom delivery aspect ratios.",
    execution: "fused-pixel",
    parameters: [
      choice("aspect", "Aspect Ratio", ["2.39:1", "1.85:1", "1:1", "Custom"]),
      number("customRatio", "Custom Ratio", 2, 0.2, 8, 0.01),
      color("color", "Matte Color", 0x000000),
      percent("opacity", "Matte Opacity", 100),
      number("feather", "Edge Feather", 0, 0, 256, 0.25, "px"),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "edge-feather",
    name: "Edge Feather",
    category: "Matte",
    description: "Fade rectangular or elliptical frame edges with a controllable response curve.",
    execution: "fused-pixel",
    parameters: [
      number("width", "Feather Width", 72, 0, 2000, 1, "px"),
      choice("shape", "Shape", ["Rectangle", "Ellipse"]),
      number("curve", "Curve", 1.4, 0.1, 8, 0.1),
      percent("amount", "Amount", 100),
    ],
  },
  {
    type: "overscan",
    name: "Overscan",
    category: "Transform",
    description:
      "Scale around a movable center for clean edge-safe delivery and stabilization cleanup.",
    execution: "fused-pixel",
    parameters: [
      number("scale", "Scale", 103, 1, 1000, 0.1, "%"),
      percent("centerX", "Center X", 50),
      percent("centerY", "Center Y", 50),
      toggle("mirrorEdges", "Mirror Edges", 1),
      percent("blend", "Blend", 100),
    ],
  },
];
