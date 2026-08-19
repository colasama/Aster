import { visibleLayersAtTime } from "../core/scene-evaluation";
import { evaluateEffectParameter } from "../core/timeline";
import type { Composition, Effect, Layer } from "../core/types";
import { EffectOpcode } from "./effect-opcodes";
import { compileChannelKeyingEffect } from "./effect-program-channel-keying";

export { EffectOpcode } from "./effect-opcodes";

export const MAX_EFFECT_OPERATIONS = 64;
export const FLOATS_PER_EFFECT_OPERATION = 16;

export interface EffectProgram {
  data: Float32Array;
  count: number;
}

export function compileEffectProgram(
  composition: Composition,
  time = 0,
  layers: Layer[] = visibleLayersAtTime(composition, time),
): EffectProgram {
  const values = new Float32Array(MAX_EFFECT_OPERATIONS * FLOATS_PER_EFFECT_OPERATION);
  let count = 0;
  const emit = (opcode: EffectOpcode, parameters: number[]) => {
    if (count >= MAX_EFFECT_OPERATIONS) return;
    const offset = count * FLOATS_PER_EFFECT_OPERATION;
    values[offset] = opcode;
    values.set(parameters.slice(0, FLOATS_PER_EFFECT_OPERATION - 1), offset + 1);
    count += 1;
  };
  for (const layer of [...layers].reverse()) {
    for (const effect of layer.effects) {
      if (!effect.enabled) continue;
      if (effect.mask) {
        emit(EffectOpcode.MaskBegin, [
          effect.mask.center[0] / 100,
          effect.mask.center[1] / 100,
          effect.mask.size[0] / 100,
          effect.mask.size[1] / 100,
          effect.mask.feather,
          effect.mask.opacity / 100,
          effect.mask.invert ? 1 : 0,
          effect.mask.shape === "rectangle" ? 1 : 0,
        ]);
      }
      compileEffect(effect, time, emit);
      if (effect.mask) emit(EffectOpcode.MaskEnd, []);
    }
  }
  return { data: values, count };
}

function compileEffect(
  effect: Effect,
  time: number,
  emit: (opcode: EffectOpcode, parameters: number[]) => void,
): void {
  if (compileChannelKeyingEffect(effect, time, emit)) return;
  const value = (key: string, fallback = 0) => evaluateEffectParameter(effect, key, time, fallback);
  const color = (key: string, fallback: number) => colorChannels(value(key, fallback));
  switch (effect.type) {
    case "brightness-contrast":
      emit(EffectOpcode.BrightnessContrast, [value("brightness"), value("contrast", 1)]);
      break;
    case "exposure":
      emit(EffectOpcode.Exposure, [value("exposure"), value("offset"), value("gamma", 1)]);
      break;
    case "color-matrix":
      emit(EffectOpcode.ColorMatrix, [
        value("contrast", 1),
        value("saturation", 1),
        value("gain", 1),
      ]);
      break;
    case "vibrance":
      emit(EffectOpcode.Vibrance, [value("vibrance"), value("saturation", 1)]);
      break;
    case "gaussian-blur":
      emit(EffectOpcode.Blur, [value("radius", 18), 0, value("repeatEdge", 1)]);
      break;
    case "kawase-blur":
      emit(EffectOpcode.Blur, [value("radius", 24), 1, value("iterations", 4)]);
      break;
    case "glow":
      emit(EffectOpcode.Glow, [
        value("threshold", 0.65),
        value("radius", 42),
        value("intensity", 1.1),
        value("composite"),
        0,
      ]);
      break;
    case "bloom":
      emit(EffectOpcode.Glow, [
        value("threshold", 0.8),
        value("radius", 96),
        value("intensity", 0.8),
        0,
        value("anamorphic"),
      ]);
      break;
    case "chromatic":
      emit(EffectOpcode.ChromaticAberration, [
        value("amount", 6),
        degrees(value("angle")),
        value("falloff", 1),
      ]);
      break;
    case "looks-color-lab":
      emit(EffectOpcode.LooksColorLab, [
        value("temperature"),
        value("tint"),
        value("exposure"),
        value("contrast", 1.08),
        value("pivot", 0.42),
        value("saturation", 1),
        value("vibrance", 0.15),
        value("lift"),
        value("gamma", 1),
        value("gain", 1),
        value("fade"),
        value("vignette", 0.22),
        value("grain", 0.04),
        value("bloom", 0.35),
      ]);
      break;
    case "film-emulation":
      emit(EffectOpcode.FilmEmulation, [
        value("stock"),
        value("strength", 1),
        value("grain", 0.08),
        value("halation", 0.18),
        value("weave"),
      ]);
      break;
    case "mosaic":
      emit(EffectOpcode.Mosaic, [value("blocksX", 64), value("blocksY", 36)]);
      break;
    case "posterize":
      emit(EffectOpcode.Posterize, [value("levels", 8)]);
      break;
    case "tint":
      emit(EffectOpcode.Tint, [
        ...color("black", 0x152446),
        value("amount", 100) / 100,
        ...color("white", 0xdce8ff),
      ]);
      break;
    case "channel-mixer":
      emit(EffectOpcode.ChannelMixer, [
        value("red", 1),
        value("green", 1),
        value("blue", 1),
        value("monochrome"),
      ]);
      break;
    case "twirl":
      emit(EffectOpcode.Twirl, [degrees(value("angle", 60)), value("radius", 280)]);
      break;
    case "bulge":
      emit(EffectOpcode.Bulge, [value("radius", 300), value("height", 0.5), value("taper", 1)]);
      break;
    case "wave-warp":
      emit(EffectOpcode.WaveWarp, [
        value("height", 24),
        value("width", 320),
        degrees(value("direction", 90)),
        value("speed", 1),
      ]);
      break;
    case "find-edges":
      emit(EffectOpcode.FindEdges, [value("invert"), value("blend") / 100]);
      break;
    case "emboss":
      emit(EffectOpcode.Emboss, [
        degrees(value("direction", 135)),
        value("relief", 2),
        value("contrast", 1),
        value("blend") / 100,
      ]);
      break;
    case "linear-wipe":
      emit(EffectOpcode.LinearWipe, [
        value("completion", 50) / 100,
        degrees(value("angle")),
        value("feather"),
      ]);
      break;
    case "radial-wipe":
      emit(EffectOpcode.RadialWipe, [
        value("completion", 50) / 100,
        degrees(value("startAngle")),
        degrees(value("feather")),
      ]);
      break;
    case "split-tone":
      emit(EffectOpcode.SplitTone, [
        degrees(value("shadowHue", 220)),
        value("shadowAmount", 0.12),
        degrees(value("highlightHue", 38)),
        value("highlightAmount", 0.1),
        value("balance"),
      ]);
      break;
    case "checkerboard":
      emit(EffectOpcode.Checkerboard, [
        value("size", 80),
        value("opacity", 100) / 100,
        0,
        ...color("color1", 0x141824),
        0,
        ...color("color2", 0x334267),
      ]);
      break;
    case "grid":
      emit(EffectOpcode.Grid, [
        value("width", 120),
        value("height", 120),
        value("border", 2),
        ...color("color", 0x6f86b7),
      ]);
      break;
    case "four-color-gradient":
      emit(EffectOpcode.FourColorGradient, [
        ...color("color1", 0x172968),
        value("blend", 0.5),
        ...color("color2", 0x723dd8),
        0,
        ...color("color3", 0x189bc0),
        0,
        ...color("color4", 0x0b1029),
      ]);
      break;
    case "fractal-noise":
      emit(EffectOpcode.FractalNoise, [
        value("contrast", 1.2),
        value("brightness"),
        value("scale", 180),
        value("complexity", 4),
        value("evolution"),
      ]);
      break;
    case "sharpen":
      emit(EffectOpcode.Sharpen, [
        value("amount", 60) / 100,
        value("radius", 1.5),
        value("threshold") / 255,
      ]);
      break;
    case "directional-blur":
      emit(EffectOpcode.DirectionalBlur, [value("length", 24), degrees(value("direction"))]);
      break;
    case "radial-blur":
      emit(EffectOpcode.RadialBlur, [value("amount", 12) / 100, value("mode")]);
      break;
    case "chroma-key":
      emit(EffectOpcode.ChromaKey, [
        ...color("keyColor", 0x00ff65),
        value("tolerance", 0.18),
        value("softness", 0.08),
        value("spill", 0.6),
      ]);
      break;
    case "luma-key":
      emit(EffectOpcode.LumaKey, [value("mode"), value("threshold", 0.5), value("softness", 0.1)]);
      break;
    case "spill-suppressor":
      emit(EffectOpcode.SpillSuppressor, [value("color"), value("amount", 1), value("range", 0.5)]);
      break;
    case "color-balance":
      emit(EffectOpcode.ColorBalance, [
        value("shadows"),
        value("midtones"),
        value("highlights"),
        value("preserveLuminosity", 1),
      ]);
      break;
    case "transform":
      emit(EffectOpcode.Transform, [
        value("positionX"),
        value("positionY"),
        value("scale", 100) / 100,
        degrees(value("rotation")),
      ]);
      break;
    case "turbulent-displace":
      emit(EffectOpcode.TurbulentDisplace, [
        value("amount", 50),
        value("size", 100),
        value("complexity", 2),
        value("evolution"),
      ]);
      break;
    case "displacement-map":
      emit(EffectOpcode.Displacement, [value("horizontal", 25), value("vertical", 25)]);
      break;
    case "levels":
      emit(EffectOpcode.Levels, [
        value("inputBlack"),
        value("inputWhite", 1),
        value("gamma", 1),
        value("outputBlack"),
        value("outputWhite", 1),
      ]);
      break;
    case "curves":
      emit(EffectOpcode.Curves, [value("shadows"), value("midtones"), value("highlights")]);
      break;
    case "minimax":
      emit(EffectOpcode.Minimax, [value("radius", 2), value("operation"), value("channel")]);
      break;
    case "posterize-time":
      emit(EffectOpcode.PosterizeTime, [value("frameRate", 12)]);
      break;
    case "hue-saturation":
      emit(EffectOpcode.HueSaturation, [
        degrees(value("hue")),
        value("saturation", 1),
        value("lightness"),
      ]);
      break;
    case "lut":
      emit(EffectOpcode.Lut, [
        value("intensity", 100) / 100,
        value("interpolation"),
        ...(effect.resource?.domainMin ?? [0, 0, 0]),
        ...(effect.resource?.domainMax ?? [1, 1, 1]),
      ]);
      break;
    case "bilateral-blur":
      emit(EffectOpcode.BilateralBlur, [value("radius", 12), value("threshold", 0.12)]);
      break;
    case "echo":
      emit(EffectOpcode.Echo, [
        value("echoTime", -0.033),
        value("echoes", 8),
        value("decay", 0.8),
        value("operator"),
      ]);
      break;
    case "motion-trails":
      emit(EffectOpcode.MotionTrails, [
        value("samples", 12),
        value("duration", 0.35),
        value("decay", 0.82),
      ]);
      break;
    case "particle-world":
      emit(EffectOpcode.ParticleWorld, [
        value("birthRate", 2),
        value("longevity", 3),
        value("velocity", 1),
        value("gravity", 0.5),
        value("seed", 1),
      ]);
      break;
    case "fill":
      emit(EffectOpcode.Fill, [...color("color", 0x4d80ff), value("opacity", 100) / 100]);
      break;
    case "invert":
      emit(EffectOpcode.Invert, [value("channel"), value("blend", 100) / 100]);
      break;
    case "threshold":
      emit(EffectOpcode.Threshold, [value("level", 0.5), value("smoothness", 0.02)]);
      break;
    case "noise":
      emit(EffectOpcode.Noise, [value("amount", 12) / 100, value("colorNoise", 1)]);
      break;
    case "mirror":
      emit(EffectOpcode.Mirror, [degrees(value("angle")), value("center", 50) / 100]);
      break;
    case "motion-tile":
      emit(EffectOpcode.MotionTile, [
        value("outputWidth", 200) / 100,
        value("outputHeight", 200) / 100,
        value("mirrorEdges", 1),
      ]);
      break;
    case "venetian-blinds":
      emit(EffectOpcode.VenetianBlinds, [
        value("completion", 50) / 100,
        degrees(value("direction", 90)),
        value("width", 80),
        value("feather", 4),
      ]);
      break;
    case "gradient-ramp":
      emit(EffectOpcode.GradientRamp, [
        ...color("startColor", 0x172968),
        degrees(value("angle", 90)),
        ...color("endColor", 0x8d74ef),
        value("blend", 100) / 100,
      ]);
      break;
    case "drop-shadow":
      emit(EffectOpcode.DropShadow, [
        ...color("color", 0x000000),
        value("opacity", 60) / 100,
        degrees(value("direction", 135)),
        value("distance", 24),
        value("softness", 18),
      ]);
      break;
    case "tritone":
      emit(EffectOpcode.Tritone, [
        ...color("shadows", 0x152446),
        ...color("midtones", 0x6d74a8),
        ...color("highlights", 0xdce8ff),
        value("blend", 100) / 100,
      ]);
      break;
    case "lens-distortion":
      emit(EffectOpcode.LensDistortion, [value("curvature", 0.18), value("zoom", 100) / 100]);
      break;
    case "black-white":
      emit(EffectOpcode.BlackWhite, [
        value("reds", 0.3),
        value("greens", 0.59),
        value("blues", 0.11),
        value("tint", 0),
        ...color("tintColor", 0xb8c8e8),
      ]);
      break;
    case "colorama":
      emit(EffectOpcode.Colorama, [
        degrees(value("phase")),
        value("palette"),
        value("saturation", 1),
        value("blend", 100) / 100,
      ]);
      break;
    case "light-sweep":
      emit(EffectOpcode.LightSweep, [
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        degrees(value("direction", 45)),
        value("width", 120),
        value("intensity", 2),
        value("edgeThickness", 1.5),
        value("blend", 100) / 100,
        ...color("color", 0xffffff),
      ]);
      break;
    case "kaleidoscope":
      emit(EffectOpcode.Kaleidoscope, [
        value("segments", 8),
        degrees(value("rotation")),
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("zoom", 100) / 100,
      ]);
      break;
    case "bevel-alpha":
      emit(EffectOpcode.BevelAlpha, [
        degrees(value("direction", 135)),
        value("relief", 4),
        value("intensity", 1),
        value("blend", 100) / 100,
        ...color("highlightColor", 0xffffff),
        ...color("shadowColor", 0x101528),
      ]);
      break;
    case "glass":
      emit(EffectOpcode.Glass, [
        value("softness", 2),
        value("height", 6),
        value("displacement", 12),
        degrees(value("lightDirection", 315)),
        value("lightHeight", 1.5),
        value("blend", 100) / 100,
      ]);
      break;
    case "cartoon":
      emit(EffectOpcode.Cartoon, [
        value("edgeThreshold", 0.16),
        value("levels", 6),
        value("edgeSoftness", 0.04),
        value("blend", 100) / 100,
      ]);
      break;
    case "solarize":
      emit(EffectOpcode.Solarize, [value("threshold", 0.5), value("blend", 100) / 100]);
      break;
    case "simple-choker":
      emit(EffectOpcode.SimpleChoker, [value("choke", 2), value("softness", 1)]);
      break;
    case "box-blur":
      emit(EffectOpcode.BoxBlur, [value("radius", 12)]);
      break;
    case "camera-lens-blur":
      emit(EffectOpcode.CameraLensBlur, [
        value("radius", 18),
        degrees(value("rotation")),
        value("highlightThreshold", 0.72),
        value("highlightGain", 1.25),
      ]);
      break;
    case "change-to-color":
      emit(EffectOpcode.ChangeToColor, [
        ...color("fromColor", 0x3d65ff),
        value("tolerance", 0.22),
        value("softness", 0.12),
        ...color("toColor", 0xff4fa7),
        value("preserveLuminance", 1),
      ]);
      break;
    case "leave-color":
      emit(EffectOpcode.LeaveColor, [
        ...color("color", 0xff3b72),
        value("tolerance", 0.24),
        value("softness", 0.16),
        value("amount", 100) / 100,
      ]);
      break;
    case "extract":
      emit(EffectOpcode.Extract, [
        value("blackPoint", 0.12),
        value("whitePoint", 0.88),
        value("softness", 0.04),
        value("invert"),
      ]);
      break;
    case "roughen-edges":
      emit(EffectOpcode.RoughenEdges, [
        value("border", 12),
        value("scale", 80),
        value("complexity", 3),
        value("evolution"),
        value("sharpness", 0.15),
      ]);
      break;
    case "light-burst":
      emit(EffectOpcode.LightBurst, [
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("rayLength", 160),
        value("intensity", 1.4),
        value("blend", 100) / 100,
        ...color("color", 0x9ddcff),
      ]);
      break;
    case "radial-shadow":
      emit(EffectOpcode.RadialShadow, [
        value("centerX", 50) / 100,
        value("centerY", 35) / 100,
        value("distance", 48),
        value("opacity", 55) / 100,
        value("softness", 18),
        ...color("color", 0x08101f),
      ]);
      break;
    case "ball-action":
      emit(EffectOpcode.BallAction, [
        value("gridSize", 36),
        value("ballSize", 72) / 100,
        value("scatter"),
        degrees(value("twist")),
        value("blend", 100) / 100,
      ]);
      break;
    case "hex-tile":
      emit(EffectOpcode.HexTile, [
        value("tileSize", 64),
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        degrees(value("rotation")),
        value("scale", 100) / 100,
        value("blend", 100) / 100,
      ]);
      break;
    case "beam":
      emit(EffectOpcode.Beam, [
        value("startX", 25) / 100,
        value("startY", 50) / 100,
        value("endX", 75) / 100,
        value("endY", 50) / 100,
        value("thickness", 12),
        value("softness", 8),
        value("intensity", 2),
        ...color("startColor", 0xe8fbff),
        value("blend", 100) / 100,
        ...color("endColor", 0x3293ff),
      ]);
      break;
    case "radio-waves":
      emit(EffectOpcode.RadioWaves, [
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("frequency", 6),
        value("speed", 120),
        value("width", 4),
        value("intensity", 1.5),
        value("fade", 65) / 100,
        ...color("color", 0x56c8ff),
        value("blend", 100) / 100,
      ]);
      break;
    case "advanced-lightning":
      emit(EffectOpcode.AdvancedLightning, [
        value("startX", 28) / 100,
        value("startY", 20) / 100,
        value("endX", 72) / 100,
        value("endY", 80) / 100,
        value("amplitude", 48),
        value("frequency", 8),
        value("evolution"),
        value("thickness", 2.5),
        value("glow", 22),
        ...color("color", 0xbde8ff),
        value("blend", 100) / 100,
      ]);
      break;
    case "circle":
      emit(EffectOpcode.Circle, [
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("radius", 240),
        value("thickness", 12),
        value("feather", 2),
        value("mode"),
        ...color("color", 0x52a8ff),
        value("opacity", 100) / 100,
        value("blend", 100) / 100,
      ]);
      break;
    case "star-burst":
      emit(EffectOpcode.StarBurst, [
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("rays", 24),
        value("radius", 420),
        degrees(value("rotation")),
        value("sharpness", 12),
        value("intensity", 1.2),
        ...color("color", 0x70b7ff),
        value("blend", 100) / 100,
      ]);
      break;
    case "polar-coordinates":
      emit(EffectOpcode.PolarCoordinates, [
        value("mode"),
        value("interpolation", 100) / 100,
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        degrees(value("rotation")),
      ]);
      break;
    case "offset":
      emit(EffectOpcode.Offset, [value("shiftX"), value("shiftY"), value("wrapEdges", 1)]);
      break;
    case "magnify":
      emit(EffectOpcode.Magnify, [
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("magnification", 2),
        value("size", 280),
        value("feather", 48),
        value("shape"),
      ]);
      break;
    case "ripple":
      emit(EffectOpcode.Ripple, [
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("height", 18),
        value("width", 120),
        value("radius", 600),
        value("phase"),
        value("speed", 1),
      ]);
      break;
    case "corner-pin":
      emit(EffectOpcode.CornerPin, [
        value("upperLeftX") / 100,
        value("upperLeftY") / 100,
        value("upperRightX", 100) / 100,
        value("upperRightY") / 100,
        value("lowerLeftX") / 100,
        value("lowerLeftY", 100) / 100,
        value("lowerRightX", 100) / 100,
        value("lowerRightY", 100) / 100,
        value("blend", 100) / 100,
      ]);
      break;
    case "lens-flare":
      emit(EffectOpcode.LensFlare, [
        value("centerX", 58) / 100,
        value("centerY", 38) / 100,
        value("brightness", 1.8),
        value("scale", 180),
        degrees(value("angle")),
        value("lensType"),
        ...color("color", 0xa8cfff),
        value("blend", 100) / 100,
      ]);
      break;
    case "cell-pattern":
      emit(EffectOpcode.CellPattern, [
        value("cellSize", 120),
        value("contrast", 1.4),
        value("evolution"),
        value("pattern"),
        value("invert"),
        ...color("color1", 0x102656),
        ...color("color2", 0x6edaff),
        value("blend", 100) / 100,
      ]);
      break;
    case "rainfall":
      emit(EffectOpcode.Rainfall, [
        value("density", 1),
        value("speed", 900),
        degrees(value("direction", 78)),
        value("length", 48),
        value("width", 1.5),
        value("seed", 1),
        ...color("color", 0xa8d8ff),
        value("opacity", 70) / 100,
      ]);
      break;
    case "snowfall":
      emit(EffectOpcode.Snowfall, [
        value("density", 1),
        value("speed", 140),
        value("size", 5),
        value("wind", 55),
        value("turbulence", 24),
        value("seed", 1),
        ...color("color", 0xe8f4ff),
        value("opacity", 85) / 100,
      ]);
      break;
    case "block-dissolve":
      emit(EffectOpcode.BlockDissolve, [
        value("completion", 50) / 100,
        value("blockWidth", 64),
        value("blockHeight", 36),
        value("softness", 4) / 100,
        value("seed", 1),
      ]);
      break;
    case "iris-wipe":
      emit(EffectOpcode.IrisWipe, [
        value("completion", 50) / 100,
        value("shape"),
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("feather", 12),
        value("invert"),
      ]);
      break;
    case "barn-doors":
      emit(EffectOpcode.BarnDoors, [
        value("completion", 50) / 100,
        value("direction"),
        value("center", 50) / 100,
        value("feather", 8),
        value("invert"),
      ]);
      break;
    case "gradient-wipe":
      emit(EffectOpcode.GradientWipe, [
        value("completion", 50) / 100,
        value("softness", 12) / 100,
        value("scale", 180),
        value("complexity", 4),
        value("evolution"),
        value("invert"),
      ]);
      break;
    case "burn-film":
      emit(EffectOpcode.BurnFilm, [
        value("burn", 38) / 100,
        value("centerX", 50) / 100,
        value("centerY", 50) / 100,
        value("turbulence", 90),
        value("edgeWidth", 26),
        value("intensity", 2.4),
        value("evolution"),
        ...color("color", 0xff6b18),
      ]);
      break;
    case "strobe-light":
      emit(EffectOpcode.StrobeLight, [
        value("frequency", 8),
        value("dutyCycle", 35) / 100,
        value("phase"),
        value("operator"),
        ...color("color", 0xffffff),
        value("opacity", 100) / 100,
      ]);
      break;
    case "scatter":
      emit(EffectOpcode.Scatter, [
        value("horizontal", 18),
        value("vertical", 18),
        value("grain", 6),
        value("seed", 1),
        value("evolution"),
      ]);
      break;
    case "brush-strokes":
      emit(EffectOpcode.BrushStrokes, [
        degrees(value("direction", 25)),
        value("length", 26),
        value("roughness", 0.4),
        value("grain", 48),
        value("levels", 12),
        value("blend", 100) / 100,
      ]);
      break;
    case "photo-filter":
      emit(EffectOpcode.PhotoFilter, [
        ...color("color", 0xffa34d),
        value("density", 25) / 100,
        value("preserveLuminance", 1),
        value("exposure"),
      ]);
      break;
    case "selective-color":
      emit(EffectOpcode.SelectiveColor, [
        value("target"),
        value("cyan") / 100,
        value("magenta") / 100,
        value("yellow") / 100,
        value("black") / 100,
        value("relative", 1),
      ]);
      break;
    case "shadows-highlights":
      emit(EffectOpcode.ShadowsHighlights, [
        value("shadows", 30) / 100,
        value("highlights", 20) / 100,
        value("shadowWidth", 50) / 100,
        value("highlightWidth", 50) / 100,
        value("colorCorrection", 20) / 100,
        value("midtoneContrast"),
      ]);
      break;
    case "gamma-pedestal-gain":
      emit(EffectOpcode.GammaPedestalGain, [
        value("gamma", 1),
        value("pedestal"),
        value("gain", 1),
        value("redGain", 1),
        value("greenGain", 1),
        value("blueGain", 1),
      ]);
      break;
    case "hdr-compander":
      emit(EffectOpcode.HdrCompander, [
        value("mode"),
        value("threshold", 0.7),
        value("ratio", 4),
        value("exposure"),
        value("blend", 100) / 100,
      ]);
      break;
    case "broadcast-colors":
      emit(EffectOpcode.BroadcastColors, [
        value("standard"),
        value("maximumSignal", 1),
        value("method"),
        value("softness", 0.08),
        value("blend", 100) / 100,
      ]);
      break;
    case "white-balance":
      emit(EffectOpcode.WhiteBalance, [
        value("temperature"),
        value("tint"),
        value("adaptation", 100) / 100,
        value("preserveLuminance", 1),
      ]);
      break;
    case "color-emboss":
      emit(EffectOpcode.ColorEmboss, [
        degrees(value("direction", 135)),
        value("relief", 2),
        value("contrast", 1.5),
        value("blend", 100) / 100,
      ]);
      break;
  }
}

function colorChannels(value: number): [number, number, number] {
  const color = Math.max(0, Math.min(0xffffff, Math.round(value)));
  return [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255];
}

function degrees(value: number): number {
  return (value * Math.PI) / 180;
}
