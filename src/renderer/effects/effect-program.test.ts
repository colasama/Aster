import { describe, expect, it } from "vitest";
import { activeComposition, createDemoProject } from "../../core/project/project";
import { createEffect, EFFECT_REGISTRY } from "../../effects/registry";
import {
  compileEffectProgram,
  EffectOpcode,
  FLOATS_PER_EFFECT_OPERATION,
  MAX_EFFECT_OPERATIONS,
} from "./effect-program";

describe("GPU effect program compiler", () => {
  it("keeps effect opcodes unique and contiguous", () => {
    const opcodes = Object.values(EffectOpcode)
      .filter((value): value is number => typeof value === "number")
      .sort((left, right) => left - right);
    const expected = Array.from(
      { length: EffectOpcode.MultiStopGradient },
      (_, index) => index + 1,
    );
    expect(opcodes).toEqual(expected);
  });

  it("preserves enabled effect order and packs color parameters", () => {
    const composition = activeComposition(createDemoProject());
    composition.layers.forEach((layer) => {
      layer.effects = [];
    });
    const tint = createEffect("tint");
    tint.parameters.black = 0xff0000;
    tint.parameters.white = 0x00ff00;
    const posterize = createEffect("posterize");
    composition.layers[0].effects.push(tint, posterize);

    const program = compileEffectProgram(composition);

    expect(program.count).toBe(2);
    expect(program.data[0]).toBe(EffectOpcode.Tint);
    expect(program.data[1]).toBe(1);
    expect(program.data[2]).toBe(0);
    expect(program.data[3]).toBe(0);
    expect(program.data[5]).toBe(0);
    expect(program.data[6]).toBe(1);
    expect(program.data[FLOATS_PER_EFFECT_OPERATION]).toBe(EffectOpcode.Posterize);
  });

  it("skips disabled effects and caps untrusted project programs", () => {
    const composition = activeComposition(createDemoProject());
    composition.layers.forEach((layer) => {
      layer.effects = [];
    });
    const layer = composition.layers[0];
    for (let index = 0; index < MAX_EFFECT_OPERATIONS + 8; index += 1) {
      layer.effects.push(createEffect("posterize"));
    }
    layer.effects[0].enabled = false;

    expect(compileEffectProgram(composition).count).toBe(MAX_EFFECT_OPERATIONS);
  });

  it("preserves legacy overlays and evaluates bounded scene-linear intensity at arbitrary time", () => {
    const composition = activeComposition(createDemoProject());
    const layer = composition.layers[0];
    const overlay = createEffect("color-overlay");
    overlay.parameters = { color: 0x804020, opacity: 75, blendMode: 0 };
    layer.effects = [overlay];
    const legacy = compileEffectProgram(composition, 0, [layer]);
    expect(legacy.count).toBe(1);
    expect(legacy.data[1]).toBeCloseTo(128 / 255);
    expect(legacy.data[4]).toBe(0.75);
    overlay.parameterKeyframes = {
      intensity: [
        { id: "dim", time: 0, value: 0, interpolation: "linear" },
        { id: "bright", time: 2, value: 4, interpolation: "linear" },
      ],
    };
    for (const time of [2, 0, 1, 2]) {
      const program = compileEffectProgram(composition, time, [layer]);
      expect(program.count).toBe(1);
      expect(program.data[1]).toBeCloseTo((128 / 255) * time * 2);
      expect(program.data[2]).toBeCloseTo((64 / 255) * time * 2);
      expect(program.data[3]).toBeCloseTo((32 / 255) * time * 2);
      expect(program.data[4]).toBe(0.75);
    }
    delete overlay.parameterKeyframes;
    overlay.parameters.intensity = 100;
    expect(compileEffectProgram(composition, 0, [layer]).data[1]).toBeCloseTo((128 / 255) * 16);
  });

  it("packs imported LUT domains into the GPU program", () => {
    const composition = activeComposition(createDemoProject());
    composition.layers.forEach((layer) => {
      layer.effects = [];
    });
    const lut = createEffect("lut");
    lut.resource = {
      kind: "lut3d",
      name: "range.cube",
      size: 2,
      data: new Array(24).fill(0),
      domainMin: [-1, 0, 0.1],
      domainMax: [2, 1, 0.9],
      checksum: "12345678",
    };
    composition.layers[0].effects = [lut];

    const program = compileEffectProgram(composition);

    expect([...program.data.slice(3, 5)]).toEqual([-1, 0]);
    expect(program.data[5]).toBeCloseTo(0.1);
    expect([...program.data.slice(6, 8)]).toEqual([2, 1]);
    expect(program.data[8]).toBeCloseTo(0.9);
  });

  it("evaluates animated effect parameters at the requested render time", () => {
    const composition = activeComposition(createDemoProject());
    composition.layers.forEach((layer) => {
      layer.effects = [];
    });
    const posterize = createEffect("posterize");
    posterize.parameterKeyframes = {
      levels: [
        { id: "low", time: 0, value: 2, interpolation: "linear" },
        { id: "high", time: 2, value: 10, interpolation: "linear" },
      ],
    };
    composition.layers[0].effects = [posterize];

    expect(compileEffectProgram(composition, 1).data[1]).toBe(6);
  });

  it("keeps old wipes straight and scales animated edge bends with preview resolution", () => {
    const composition = activeComposition(createDemoProject());
    const layer = composition.layers[0];
    const wipe = createEffect("linear-wipe");
    wipe.parameters = { completion: 50, angle: 180, feather: 8 };
    layer.effects = [wipe];
    const old = compileEffectProgram(composition, 0, [layer]);
    expect(old.count).toBe(1);
    expect(old.data[4]).toBe(0);
    wipe.parameters = {
      ...wipe.parameters,
      bend: 120,
      bendWidth: 800,
      bendPhase: 90,
      bendSpeed: -180,
    };
    wipe.parameterKeyframes = {
      bend: [
        { id: "low", time: 0, value: 120, interpolation: "linear" },
        { id: "high", time: 2, value: 200, interpolation: "linear" },
      ],
    };
    const half = compileEffectProgram(composition, 1, [layer], 0.5);
    expect(half.count).toBe(1);
    expect([...half.data.slice(3, 6)]).toEqual([4, 80, 400]);
    expect(half.data[6]).toBeCloseTo(Math.PI / 2);
    expect(half.data[7]).toBeCloseTo(-Math.PI);
  });

  it("keeps former aggregate effects in explicit layer order", () => {
    const composition = activeComposition(createDemoProject());
    composition.layers.forEach((layer) => {
      layer.effects = [];
    });
    composition.layers[0].effects = [
      createEffect("posterize"),
      createEffect("exposure"),
      createEffect("looks-color-lab"),
    ];

    const program = compileEffectProgram(composition);

    expect(program.count).toBe(3);
    expect(program.data[0]).toBe(EffectOpcode.Posterize);
    expect(program.data[FLOATS_PER_EFFECT_OPERATION]).toBe(EffectOpcode.Exposure);
    expect(program.data[FLOATS_PER_EFFECT_OPERATION * 2]).toBe(EffectOpcode.LooksColorLab);
  });

  it("gives every catalog effect a GPU program path", () => {
    const composition = activeComposition(createDemoProject());
    composition.layers.forEach((layer) => {
      layer.effects = [];
    });
    for (const definition of EFFECT_REGISTRY) {
      composition.layers[0].effects = [createEffect(definition.type)];
      expect(compileEffectProgram(composition).count, definition.type).toBeGreaterThan(0);
    }
  });

  it("wraps a masked effect in bounded mask operations", () => {
    const composition = activeComposition(createDemoProject());
    composition.layers.forEach((layer) => {
      layer.effects = [];
    });
    const exposure = createEffect("exposure");
    exposure.mask = {
      shape: "rectangle",
      center: [40, 60],
      size: [70, 30],
      feather: 18,
      opacity: 75,
      invert: true,
    };
    composition.layers[0].effects = [exposure];

    const program = compileEffectProgram(composition);

    expect(program.count).toBe(3);
    expect(program.data[0]).toBe(EffectOpcode.MaskBegin);
    expect(program.data[1]).toBeCloseTo(0.4);
    expect(program.data[4]).toBeCloseTo(0.3);
    expect(program.data[6]).toBeCloseTo(0.75);
    expect(program.data[7]).toBe(1);
    expect(program.data[FLOATS_PER_EFFECT_OPERATION]).toBe(EffectOpcode.Exposure);
    expect(program.data[FLOATS_PER_EFFECT_OPERATION * 2]).toBe(EffectOpcode.MaskEnd);
  });

  it.each([
    ["bilateral-blur", EffectOpcode.BilateralBlur],
    ["echo", EffectOpcode.Echo],
    ["motion-trails", EffectOpcode.MotionTrails],
    ["particle-world", EffectOpcode.ParticleWorld],
    ["fill", EffectOpcode.Fill],
    ["invert", EffectOpcode.Invert],
    ["threshold", EffectOpcode.Threshold],
    ["noise", EffectOpcode.Noise],
    ["mirror", EffectOpcode.Mirror],
    ["motion-tile", EffectOpcode.MotionTile],
    ["venetian-blinds", EffectOpcode.VenetianBlinds],
    ["gradient-ramp", EffectOpcode.GradientRamp],
    ["multi-stop-gradient", EffectOpcode.MultiStopGradient],
    ["drop-shadow", EffectOpcode.DropShadow],
    ["tritone", EffectOpcode.Tritone],
    ["lens-distortion", EffectOpcode.LensDistortion],
    ["black-white", EffectOpcode.BlackWhite],
    ["colorama", EffectOpcode.Colorama],
    ["light-sweep", EffectOpcode.LightSweep],
    ["kaleidoscope", EffectOpcode.Kaleidoscope],
    ["bevel-alpha", EffectOpcode.BevelAlpha],
    ["glass", EffectOpcode.Glass],
    ["cartoon", EffectOpcode.Cartoon],
    ["solarize", EffectOpcode.Solarize],
    ["simple-choker", EffectOpcode.SimpleChoker],
    ["box-blur", EffectOpcode.BoxBlur],
    ["camera-lens-blur", EffectOpcode.CameraLensBlur],
    ["change-to-color", EffectOpcode.ChangeToColor],
    ["leave-color", EffectOpcode.LeaveColor],
    ["extract", EffectOpcode.Extract],
    ["roughen-edges", EffectOpcode.RoughenEdges],
    ["light-burst", EffectOpcode.LightBurst],
    ["radial-shadow", EffectOpcode.RadialShadow],
    ["ball-action", EffectOpcode.BallAction],
    ["hex-tile", EffectOpcode.HexTile],
    ["beam", EffectOpcode.Beam],
    ["radio-waves", EffectOpcode.RadioWaves],
    ["advanced-lightning", EffectOpcode.AdvancedLightning],
    ["circle", EffectOpcode.Circle],
    ["star-burst", EffectOpcode.StarBurst],
    ["polar-coordinates", EffectOpcode.PolarCoordinates],
    ["offset", EffectOpcode.Offset],
    ["magnify", EffectOpcode.Magnify],
    ["ripple", EffectOpcode.Ripple],
    ["corner-pin", EffectOpcode.CornerPin],
    ["lens-flare", EffectOpcode.LensFlare],
    ["cell-pattern", EffectOpcode.CellPattern],
    ["rainfall", EffectOpcode.Rainfall],
    ["snowfall", EffectOpcode.Snowfall],
    ["block-dissolve", EffectOpcode.BlockDissolve],
    ["iris-wipe", EffectOpcode.IrisWipe],
    ["barn-doors", EffectOpcode.BarnDoors],
    ["gradient-wipe", EffectOpcode.GradientWipe],
    ["burn-film", EffectOpcode.BurnFilm],
    ["strobe-light", EffectOpcode.StrobeLight],
    ["scatter", EffectOpcode.Scatter],
    ["brush-strokes", EffectOpcode.BrushStrokes],
    ["photo-filter", EffectOpcode.PhotoFilter],
    ["selective-color", EffectOpcode.SelectiveColor],
    ["shadows-highlights", EffectOpcode.ShadowsHighlights],
    ["gamma-pedestal-gain", EffectOpcode.GammaPedestalGain],
    ["hdr-compander", EffectOpcode.HdrCompander],
    ["broadcast-colors", EffectOpcode.BroadcastColors],
    ["white-balance", EffectOpcode.WhiteBalance],
    ["color-emboss", EffectOpcode.ColorEmboss],
    ["brightness-contrast", EffectOpcode.BrightnessContrast],
    ["exposure", EffectOpcode.Exposure],
    ["color-matrix", EffectOpcode.ColorMatrix],
    ["vibrance", EffectOpcode.Vibrance],
    ["gaussian-blur", EffectOpcode.Blur],
    ["kawase-blur", EffectOpcode.Blur],
    ["glow", EffectOpcode.Glow],
    ["bloom", EffectOpcode.Glow],
    ["chromatic", EffectOpcode.ChromaticAberration],
    ["looks-color-lab", EffectOpcode.LooksColorLab],
    ["film-emulation", EffectOpcode.FilmEmulation],
    ["set-channels", EffectOpcode.SetChannels],
    ["arithmetic", EffectOpcode.Arithmetic],
    ["alpha-levels", EffectOpcode.AlphaLevels],
    ["remove-color-matting", EffectOpcode.RemoveColorMatting],
    ["linear-color-key", EffectOpcode.LinearColorKey],
    ["color-range", EffectOpcode.ColorRange],
    ["matte-choker", EffectOpcode.MatteChoker],
    ["keylight", EffectOpcode.Keylight],
    ["channel-blur", EffectOpcode.ChannelBlur],
    ["cross-blur", EffectOpcode.CrossBlur],
    ["smart-blur", EffectOpcode.SmartBlur],
    ["vector-blur", EffectOpcode.VectorBlur],
    ["radial-fast-blur", EffectOpcode.RadialFastBlur],
    ["high-pass", EffectOpcode.HighPass],
    ["sharpen-edges", EffectOpcode.SharpenEdges],
    ["compound-blur", EffectOpcode.CompoundBlur],
    ["spherize", EffectOpcode.Spherize],
    ["optics-compensation", EffectOpcode.OpticsCompensation],
    ["bend-it", EffectOpcode.BendIt],
    ["cylinder", EffectOpcode.Cylinder],
    ["sphere", EffectOpcode.Sphere],
    ["mesh-warp", EffectOpcode.MeshWarp],
    ["warp", EffectOpcode.Warp],
    ["page-turn", EffectOpcode.PageTurn],
    ["outer-glow", EffectOpcode.OuterGlow],
    ["inner-glow", EffectOpcode.InnerGlow],
    ["alpha-stroke", EffectOpcode.AlphaStroke],
    ["inner-shadow", EffectOpcode.InnerShadow],
    ["bevel-emboss-style", EffectOpcode.BevelEmbossStyle],
    ["satin", EffectOpcode.Satin],
    ["color-overlay", EffectOpcode.ColorOverlay],
    ["gradient-overlay", EffectOpcode.GradientOverlay],
    ["add-grain", EffectOpcode.AddGrain],
    ["dust-scratches", EffectOpcode.DustScratches],
    ["median", EffectOpcode.Median],
    ["noise-alpha", EffectOpcode.NoiseAlpha],
    ["noise-hls", EffectOpcode.NoiseHls],
    ["noise-hls-auto", EffectOpcode.NoiseHlsAuto],
    ["remove-grain", EffectOpcode.RemoveGrain],
    ["turbulent-noise", EffectOpcode.TurbulentNoise],
    ["clock-wipe", EffectOpcode.ClockWipe],
    ["grid-wipe", EffectOpcode.GridWipe],
    ["jaws", EffectOpcode.Jaws],
    ["light-wipe", EffectOpcode.LightWipe],
    ["line-sweep", EffectOpcode.LineSweep],
    ["scale-wipe", EffectOpcode.ScaleWipe],
    ["twister", EffectOpcode.Twister],
    ["card-wipe", EffectOpcode.CardWipe],
    ["bubbles", EffectOpcode.Bubbles],
    ["drizzle", EffectOpcode.Drizzle],
    ["hair", EffectOpcode.Hair],
    ["mr-mercury", EffectOpcode.MrMercury],
    ["particle-systems-ii", EffectOpcode.ParticleSystemsII],
    ["pixel-polly", EffectOpcode.PixelPolly],
    ["scatterize", EffectOpcode.Scatterize],
    ["wave-world", EffectOpcode.WaveWorld],
    ["color-halftone", EffectOpcode.ColorHalftone],
    ["glowing-edges", EffectOpcode.GlowingEdges],
    ["texturize", EffectOpcode.Texturize],
    ["tiles", EffectOpcode.Tiles],
    ["cc-threshold", EffectOpcode.CcThreshold],
    ["cc-toner", EffectOpcode.CcToner],
    ["cc-plastic", EffectOpcode.CcPlastic],
    ["cc-blobbylize", EffectOpcode.CcBlobbylize],
    ["refine-hard-matte", EffectOpcode.RefineHardMatte],
    ["refine-soft-matte", EffectOpcode.RefineSoftMatte],
    ["matte-feather", EffectOpcode.MatteFeather],
    ["matte-cleanup", EffectOpcode.MatteCleanup],
    ["edge-decontaminate", EffectOpcode.EdgeDecontaminate],
    ["light-wrap", EffectOpcode.LightWrap],
    ["alpha-bevel", EffectOpcode.AlphaBevel],
    ["alpha-erode-dilate", EffectOpcode.AlphaErodeDilate],
    ["light-rays", EffectOpcode.LightRays],
    ["spotlight", EffectOpcode.Spotlight],
    ["light-leak", EffectOpcode.LightLeak],
    ["anamorphic-flare", EffectOpcode.AnamorphicFlare],
    ["volumetric-fog", EffectOpcode.VolumetricFog],
    ["caustics", EffectOpcode.Caustics],
    ["god-rays", EffectOpcode.GodRays],
    ["laser", EffectOpcode.Laser],
    ["asc-cdl", EffectOpcode.AscCdl],
    ["rgb-lift-gamma-gain", EffectOpcode.RgbLiftGammaGain],
    ["log-wheels", EffectOpcode.LogWheels],
    ["hsl-secondary", EffectOpcode.HslSecondary],
    ["highlight-recovery", EffectOpcode.HighlightRecovery],
    ["gamut-compressor", EffectOpcode.GamutCompressor],
    ["false-color", EffectOpcode.FalseColor],
    ["film-print-density", EffectOpcode.FilmPrintDensity],
    ["bezier-warp", EffectOpcode.BezierWarp],
    ["flo-motion", EffectOpcode.FloMotion],
    ["griddler", EffectOpcode.Griddler],
    ["power-pin", EffectOpcode.PowerPin],
    ["ripple-pulse", EffectOpcode.RipplePulse],
    ["slant", EffectOpcode.Slant],
    ["smear", EffectOpcode.Smear],
    ["split", EffectOpcode.Split],
    ["shift-channels", EffectOpcode.ShiftChannels],
    ["channel-combiner", EffectOpcode.ChannelCombiner],
    ["solid-composite", EffectOpcode.SolidComposite],
    ["premultiply-color", EffectOpcode.PremultiplyColor],
    ["unpremultiply-color", EffectOpcode.UnpremultiplyColor],
    ["alpha-from-luminance", EffectOpcode.AlphaFromLuminance],
    ["set-matte", EffectOpcode.SetMatte],
    ["hdr-clamp", EffectOpcode.HdrClamp],
    ["ellipse", EffectOpcode.Ellipse],
    ["stroke", EffectOpcode.Stroke],
    ["vegas", EffectOpcode.Vegas],
    ["scribble", EffectOpcode.Scribble],
    ["write-on", EffectOpcode.WriteOn],
    ["eyedropper-fill", EffectOpcode.EyedropperFill],
    ["paint-bucket", EffectOpcode.PaintBucket],
    ["detail-preserving-upscale", EffectOpcode.DetailPreservingUpscale],
    ["reduce-interlace-flicker", EffectOpcode.ReduceInterlaceFlicker],
    ["deband", EffectOpcode.Deband],
    ["denoise", EffectOpcode.Denoise],
    ["clarity", EffectOpcode.Clarity],
    ["local-contrast", EffectOpcode.LocalContrast],
    ["smart-sharpen", EffectOpcode.SmartSharpen],
    ["frequency-separation", EffectOpcode.FrequencySeparation],
    ["printer-lights", EffectOpcode.PrinterLights],
    ["hue-vs-hue", EffectOpcode.HueVsHue],
    ["hue-vs-saturation", EffectOpcode.HueVsSaturation],
    ["luma-vs-saturation", EffectOpcode.LumaVsSaturation],
    ["shadow-desaturate", EffectOpcode.ShadowDesaturate],
    ["highlight-tint", EffectOpcode.HighlightTint],
    ["filmic-tone-map", EffectOpcode.FilmicToneMap],
    ["skin-tone-refine", EffectOpcode.SkinToneRefine],
    ["key-cleaner", EffectOpcode.KeyCleaner],
    ["screen-matte", EffectOpcode.ScreenMatte],
    ["core-matte", EffectOpcode.CoreMatte],
    ["despot", EffectOpcode.Despot],
    ["edge-extend", EffectOpcode.EdgeExtend],
    ["edge-color-blend", EffectOpcode.EdgeColorBlend],
    ["spill-killer", EffectOpcode.SpillKiller],
    ["wire-removal", EffectOpcode.WireRemoval],
    ["vr-rotate-sphere", EffectOpcode.VrRotateSphere],
    ["vr-plane-to-sphere", EffectOpcode.VrPlaneToSphere],
    ["vr-chromatic-aberrations", EffectOpcode.VrChromaticAberrations],
    ["vr-digital-glitch", EffectOpcode.VrDigitalGlitch],
    ["vr-color-gradients", EffectOpcode.VrColorGradients],
    ["vr-glow", EffectOpcode.VrGlow],
    ["vr-blur", EffectOpcode.VrBlur],
    ["vr-fractal-noise", EffectOpcode.VrFractalNoise],
    ["scanlines", EffectOpcode.Scanlines],
    ["tape-dropout", EffectOpcode.TapeDropout],
    ["head-switching", EffectOpcode.HeadSwitching],
    ["compression-blocks", EffectOpcode.CompressionBlocks],
    ["gate-weave", EffectOpcode.GateWeave],
    ["film-damage", EffectOpcode.FilmDamage],
    ["rgb-phosphor", EffectOpcode.RgbPhosphor],
    ["pixel-sort", EffectOpcode.PixelSort],
    ["zebra-overlay", EffectOpcode.ZebraOverlay],
    ["gamut-warning", EffectOpcode.GamutWarning],
    ["focus-peaking", EffectOpcode.FocusPeaking],
    ["alpha-boundary", EffectOpcode.AlphaBoundary],
    ["crop", EffectOpcode.Crop],
    ["letterbox", EffectOpcode.Letterbox],
    ["edge-feather", EffectOpcode.EdgeFeather],
    ["overscan", EffectOpcode.Overscan],
  ])("compiles %s into its dedicated GPU opcode", (type, opcode) => {
    const composition = activeComposition(createDemoProject());
    composition.layers.forEach((layer) => {
      layer.effects = [];
    });
    composition.layers[0].effects = [createEffect(type)];
    const program = compileEffectProgram(composition);
    expect(program.count).toBe(1);
    expect(program.data[0]).toBe(opcode);
  });
});
