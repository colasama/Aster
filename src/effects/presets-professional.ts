import type { EffectPreset } from "./presets";

export const PROFESSIONAL_LOOK_PRESETS: EffectPreset[] = [
  {
    id: "dense-film-print",
    name: "Dense Film Print",
    description: "Deep print density, protected highlights, and fine photochemical grain.",
    palette: ["#181411", "#7e5d46", "#e3c39b"],
    effects: [
      {
        type: "asc-cdl",
        parameters: {
          slopeR: 1.05,
          slopeG: 1.02,
          slopeB: 0.97,
          offsetR: -0.012,
          offsetG: -0.015,
          offsetB: -0.018,
          powerR: 0.96,
          powerG: 0.98,
          powerB: 1.02,
          saturation: 0.94,
        },
      },
      {
        type: "film-print-density",
        parameters: { cyan: 0.025, magenta: 0.015, yellow: 0.065, density: 0.08, contrast: 1.18 },
      },
      {
        type: "add-grain",
        parameters: { intensity: 10, size: 1.1, softness: 0.28, colorAmount: 18 },
      },
    ],
  },
  {
    id: "documentary-neutral",
    name: "Documentary Neutral",
    description:
      "Natural color, compressed highlight detail, and display-safe documentary contrast.",
    palette: ["#283033", "#899392", "#e0ddd1"],
    effects: [
      {
        type: "highlight-recovery",
        parameters: { threshold: 0.74, strength: 82, rolloff: 3.2, saturation: 72, blend: 100 },
      },
      {
        type: "gamut-compressor",
        parameters: { threshold: 0.66, limit: 0.9, power: 2.4, preserveLuminance: 1, blend: 100 },
      },
      {
        type: "looks-color-lab",
        parameters: { contrast: 1.06, pivot: 0.44, saturation: 0.94, vibrance: 0.08, grain: 0.018 },
      },
    ],
  },
  {
    id: "tropical-chrome",
    name: "Tropical Chrome",
    description: "Rich foliage, luminous cyan water, and crisp warm highlights.",
    palette: ["#073f3a", "#16a8a0", "#ffc36d"],
    effects: [
      {
        type: "rgb-lift-gamma-gain",
        parameters: {
          liftR: -0.012,
          liftG: 0.006,
          liftB: 0.008,
          gammaR: 1.03,
          gammaG: 0.97,
          gammaB: 0.98,
          gainR: 1.04,
          gainG: 1.08,
          gainB: 1.05,
          master: 1.02,
        },
      },
      {
        type: "hsl-secondary",
        parameters: {
          hueCenter: 132,
          hueRange: 48,
          saturationMin: 0.12,
          hueShift: 8,
          saturation: 1.24,
        },
      },
      { type: "looks-color-lab", parameters: { contrast: 1.12, saturation: 1.08, vibrance: 0.18 } },
    ],
  },
  {
    id: "moonlit-steel",
    name: "Moonlit Steel",
    description: "Steel-blue shadows, quiet midtones, and a narrow silver highlight shoulder.",
    palette: ["#071723", "#31566d", "#bdced4"],
    effects: [
      { type: "white-balance", parameters: { temperature: -0.42, tint: -0.035, adaptation: 90 } },
      {
        type: "log-wheels",
        parameters: {
          shadowHue: 218,
          shadowAmount: 0.19,
          midtoneHue: 202,
          midtoneAmount: 0.07,
          highlightHue: 48,
          highlightAmount: 0.025,
          shadowRange: 0.38,
          highlightRange: 0.76,
          saturation: 0.82,
        },
      },
      { type: "looks-color-lab", parameters: { exposure: -0.28, contrast: 1.22, vignette: 0.38 } },
    ],
  },
  {
    id: "desert-bleach",
    name: "Desert Bleach",
    description: "Sun-baked density, pale cyan shadows, and coarse low-saturation stock texture.",
    palette: ["#3c4542", "#a78c64", "#ead79e"],
    effects: [
      {
        type: "asc-cdl",
        parameters: {
          slopeR: 1.08,
          slopeG: 1.02,
          slopeB: 0.91,
          offsetR: 0.018,
          offsetG: 0.012,
          offsetB: 0.004,
          saturation: 0.64,
        },
      },
      {
        type: "log-wheels",
        parameters: { shadowHue: 188, shadowAmount: 0.08, highlightHue: 42, highlightAmount: 0.14 },
      },
      {
        type: "add-grain",
        parameters: { intensity: 18, size: 1.8, softness: 0.16, colorAmount: 8 },
      },
    ],
  },
  {
    id: "luxury-gold",
    name: "Luxury Gold",
    description:
      "Polished black density, warm metallic highlights, and a restrained optical bloom.",
    palette: ["#100d0a", "#9a681f", "#f5d276"],
    effects: [
      {
        type: "log-wheels",
        parameters: {
          shadowHue: 224,
          shadowAmount: 0.045,
          midtoneHue: 37,
          midtoneAmount: 0.095,
          highlightHue: 48,
          highlightAmount: 0.2,
          saturation: 0.92,
        },
      },
      {
        type: "film-print-density",
        parameters: { cyan: 0.015, magenta: 0.03, yellow: 0.14, density: 0.05, contrast: 1.24 },
      },
      { type: "glow", parameters: { threshold: 0.78, radius: 46, intensity: 0.38 } },
    ],
  },
  {
    id: "pastel-negative",
    name: "Pastel Negative",
    description: "Open shadows, gentle channel separation, and a creamy negative-film shoulder.",
    palette: ["#596a79", "#c3a9b1", "#f0dec1"],
    effects: [
      {
        type: "rgb-lift-gamma-gain",
        parameters: {
          liftR: 0.035,
          liftG: 0.028,
          liftB: 0.045,
          gammaR: 1.08,
          gammaG: 1.04,
          gammaB: 1.1,
          gainR: 0.98,
          gainG: 1.01,
          gainB: 1.03,
          master: 0.98,
        },
      },
      {
        type: "highlight-recovery",
        parameters: { threshold: 0.68, strength: 88, rolloff: 4.2, saturation: 58 },
      },
      {
        type: "film-emulation",
        parameters: { stock: 0, strength: 0.42, grain: 0.028, halation: 0.06 },
      },
    ],
  },
  {
    id: "cross-process-modern",
    name: "Modern Cross Process",
    description: "Cyan-green density, shifted magenta accents, and punchy reversal-style contrast.",
    palette: ["#073f45", "#a71f63", "#e7d45e"],
    effects: [
      {
        type: "asc-cdl",
        parameters: {
          slopeR: 1.08,
          slopeG: 1.03,
          slopeB: 0.93,
          offsetR: -0.01,
          offsetG: 0.018,
          offsetB: 0.008,
          powerR: 0.94,
          powerG: 1.02,
          powerB: 1.08,
          saturation: 1.08,
        },
      },
      {
        type: "hsl-secondary",
        parameters: {
          hueCenter: 308,
          hueRange: 44,
          saturationMin: 0.1,
          hueShift: 12,
          saturation: 1.2,
        },
      },
      {
        type: "looks-color-lab",
        parameters: { contrast: 1.24, pivot: 0.41, vibrance: 0.14, vignette: 0.22, grain: 0.025 },
      },
    ],
  },
];
