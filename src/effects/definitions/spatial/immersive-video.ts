import { angle, color, number, percent } from "../../parameter-builders";
import type { EffectDefinition } from "../../types";

export const IMMERSIVE_VIDEO_EFFECTS: EffectDefinition[] = [
  {
    type: "vr-rotate-sphere",
    name: "VR Rotate Sphere",
    category: "Immersive Video",
    description:
      "Rotate an equirectangular panorama with analytic yaw, pitch, and roll transforms.",
    execution: "fused-pixel",
    parameters: [
      angle("yaw", "Pan", 0),
      angle("pitch", "Tilt", 0),
      angle("roll", "Roll", 0),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "vr-plane-to-sphere",
    name: "VR Plane to Sphere",
    category: "Immersive Video",
    description:
      "Project a rectilinear plane toward a spherical field of view around a movable center.",
    execution: "fused-pixel",
    parameters: [
      number("fieldOfView", "Field of View", 90, 10, 220, 0.5, "°"),
      percent("curvature", "Curvature", 100),
      percent("centerX", "Center X", 50),
      percent("centerY", "Center Y", 50),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "vr-chromatic-aberrations",
    name: "VR Chromatic Aberrations",
    category: "Immersive Video",
    description: "Separate red and blue channels along spherical longitude with polar falloff.",
    execution: "fused-pixel",
    parameters: [
      number("redShift", "Red Shift", 0.32, -10, 10, 0.01, "°"),
      number("blueShift", "Blue Shift", -0.32, -10, 10, 0.01, "°"),
      number("polarFalloff", "Polar Falloff", 1, 0, 4, 0.01),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "vr-digital-glitch",
    name: "VR Digital Glitch",
    category: "Immersive Video",
    description: "Apply deterministic latitude-band displacement and RGB split animation.",
    execution: "fused-pixel",
    parameters: [
      number("amount", "Displacement", 32, 0, 1000, 1, "px"),
      number("bandSize", "Band Size", 48, 2, 1000, 1, "px"),
      number("speed", "Speed", 8, 0, 60, 0.25),
      number("colorSplit", "Color Split", 6, 0, 128, 0.25, "px"),
      number("seed", "Random Seed", 1, 0, 10000, 1),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "vr-color-gradients",
    name: "VR Color Gradients",
    category: "Immersive Video",
    description: "Apply a seam-free spherical latitude gradient in linear HDR color.",
    execution: "fused-pixel",
    parameters: [
      color("northColor", "North Color", 0x315acb),
      color("southColor", "South Color", 0xff7a3d),
      angle("rotation", "Gradient Rotation", 0),
      number("intensity", "Intensity", 0.45, 0, 4, 0.01),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "vr-glow",
    name: "VR Glow",
    category: "Immersive Video",
    description: "Generate thresholded HDR glow with longitude-aware sampling.",
    execution: "fused-pixel",
    parameters: [
      number("threshold", "Threshold", 0.72, 0, 8, 0.01),
      number("radius", "Radius", 18, 0.5, 512, 0.5, "px"),
      number("intensity", "Intensity", 0.8, 0, 16, 0.05),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "vr-blur",
    name: "VR Blur",
    category: "Immersive Video",
    description: "Blur longitude and latitude independently while wrapping the panorama seam.",
    execution: "fused-pixel",
    parameters: [
      number("horizontal", "Horizontal Blur", 12, 0, 512, 0.5, "px"),
      number("vertical", "Vertical Blur", 8, 0, 512, 0.5, "px"),
      percent("blend", "Blend", 100),
    ],
  },
  {
    type: "vr-fractal-noise",
    name: "VR Fractal Noise",
    category: "Immersive Video",
    description: "Overlay animated seam-aware fractal texture in equirectangular space.",
    execution: "fused-pixel",
    parameters: [
      number("scale", "Scale", 5, 0.1, 128, 0.1),
      number("evolution", "Evolution", 0.35, -20, 20, 0.05),
      number("contrast", "Contrast", 1.4, 0, 8, 0.05),
      number("brightness", "Brightness", 0, -1, 1, 0.01),
      percent("opacity", "Opacity", 45),
      percent("blend", "Blend", 100),
    ],
  },
];
