import { describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { createBlankComposition } from "../core/project";
import { staticValue } from "../core/types";
import {
  breakTextLines,
  drawTextLayer,
  textRasterResolutionScale,
  textRasterSize,
  transformedTextRasterScale,
} from "./text-rasterizer";

const monospace = (text: string) => Array.from(text).length * 10;
const graphemeMeasure = (text: string) =>
  Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length * 10;

describe("Unicode text line breaking", () => {
  it("uses bounded density buckets for parented text enlargement and reflection", () => {
    const density = transformedTextRasterScale(1, [150, -360, 100]);
    expect(density).toBeGreaterThanOrEqual(3.6);
    expect(transformedTextRasterScale(1, [150, -361, 100])).toBe(density);
    expect(transformedTextRasterScale(0.5, [150, -360, 100])).toBeGreaterThanOrEqual(1.8);
    expect(transformedTextRasterScale(1, [10000, 10000, 100])).toBe(8);
    expect(transformedTextRasterScale(1, [0, 0, 100])).toBe(1);
  });
  it("renders clean glyphs without injecting a size-dependent blue shadow", () => {
    const layer = createLayerForComposition("text", createBlankComposition());
    layer.text = "無題";
    if (layer.textAnimator) layer.textAnimator.enabled = false;
    for (const fontSize of [40, 400, 900]) {
      if (layer.textStyle) layer.textStyle.fontSize = fontSize;
      const { context, operations } = recordingContext();
      context.shadowColor = "blue";
      context.shadowBlur = 30;
      context.shadowOffsetX = 12;
      context.shadowOffsetY = 12;
      drawTextLayer(context, layer, 1920, 1080);
      expect(operations.fillText).toHaveBeenCalled();
      expect([
        context.shadowColor,
        context.shadowBlur,
        context.shadowOffsetX,
        context.shadowOffsetY,
      ]).toEqual(["transparent", 0, 0, 0]);
    }
  });
  it("supersamples text for high-magnification previews within the GPU limit", () => {
    expect(textRasterSize({ size: [400, 100] }, 4_096, 8)).toEqual({
      width: 3_200,
      height: 800,
    });
    expect(textRasterSize({ size: [1_000, 250] }, 8_192, 8)).toEqual({
      width: 8_000,
      height: 2_000,
    });
    expect(textRasterSize({ size: [2_000, 500] }, 8_192, 8)).toEqual({
      width: 8_192,
      height: 2_048,
    });
  });

  it("buckets ordinary and motion-blurred text at the same bounded resolution scale", () => {
    expect(textRasterResolutionScale(Number.NaN)).toBe(1);
    expect(textRasterResolutionScale(1)).toBe(1);
    expect(textRasterResolutionScale(1.01)).toBe(1.25);
    expect(textRasterResolutionScale(3)).toBe(3.0517578125);
    expect(textRasterResolutionScale(8)).toBe(8);
    expect(textRasterResolutionScale(12)).toBe(8);
    for (let exponent = 0; exponent < 10; exponent += 1) {
      const bucket = Math.min(8, 1.25 ** exponent);
      expect(textRasterResolutionScale(bucket)).toBe(bucket);
    }
  });

  it("wraps words while preserving explicit line breaks", () => {
    expect(breakTextLines("GPU first motion\nAster", 90, monospace)).toEqual([
      "GPU first",
      "motion",
      "Aster",
    ]);
  });

  it("breaks long CJK and emoji runs at grapheme boundaries", () => {
    expect(breakTextLines("星辰动画编辑器", 40, monospace)).toEqual(["星辰动画", "编辑器"]);
    expect(breakTextLines("👩🏽‍💻👨‍👩‍👧‍👦", 10, graphemeMeasure)).toEqual(["👩🏽‍💻", "👨‍👩‍👧‍👦"]);
  });

  it("includes tracking in wrap decisions", () => {
    expect(breakTextLines("AB CD", 45, monospace, 5)).toEqual(["AB", "CD"]);
  });

  it("applies the complete animator stack to each glyph on the shared raster path", () => {
    const layer = createLayerForComposition("text", createBlankComposition());
    layer.text = "AA";
    layer.size = [200, 100];
    layer.textStyle = {
      fontFamily: "Inter",
      fontSize: 40,
      fontWeight: 700,
      alignment: "left",
      tracking: 0,
      leading: 48,
      strokeWidth: 0,
      strokeColor: [0, 0, 0, 1],
    };
    const v = staticValue;
    layer.textAnimator = {
      enabled: true,
      groups: [
        {
          id: "complete",
          name: "Complete",
          enabled: true,
          randomSeed: 0,
          selectors: [],
          properties: {
            anchorPoint: [v(2), v(3), v(400)],
            position: [v(20), v(10), v(100)],
            scale: [v(50), v(150), v(50)],
            rotation: [v(15), v(30), v(45)],
            skew: v(20),
            skewAxis: v(10),
            opacity: v(50),
            fillColor: [v(1), v(0), v(0), v(1)],
            strokeColor: [v(0), v(0), v(1), v(1)],
            strokeWidth: v(2),
            tracking: v(5),
            lineAnchor: v(50),
            lineSpacing: [v(3), v(4)],
            characterValue: v(66),
            characterRange: "preserveCaseAndDigits",
            blur: [v(2), v(4)],
          },
        },
      ],
    };
    const { context, operations, styles } = recordingContext();

    drawTextLayer(context, layer, 200, 100, 0.5);

    expect(operations.fillText).toHaveBeenCalledTimes(2);
    expect(operations.fillText.mock.calls.every((call) => call[0] === "B")).toBe(true);
    expect(operations.strokeText).toHaveBeenCalledTimes(2);
    expect(operations.rotate).toHaveBeenCalled();
    expect(operations.transform).toHaveBeenCalled();
    expect(operations.scale.mock.calls.length).toBeGreaterThan(2);
    expect(
      operations.scale.mock.calls.some((call) => Number(call[0]) > 0.3 && Number(call[0]) < 0.35),
    ).toBe(true);
    expect(operations.translate.mock.calls.some((call) => Number(call[0]) > 20)).toBe(true);
    expect(styles.filter).toContain("blur(4px)");
    expect(styles.fillStyle).toContain("rgba(255, 0, 0, 1)");
    expect(styles.strokeStyle).toContain("rgba(0, 0, 255, 1)");
    expect(styles.globalAlpha).toContain(0.5);
    expect(styles.lineWidth).toContain(4);
  });

  it("anchors animator tracking once per line at 0, 50, and 100 percent", () => {
    const left = lineOriginForAnchor(0);
    const center = lineOriginForAnchor(50);
    const right = lineOriginForAnchor(100);

    expect(left - center).toBeCloseTo(20);
    expect(center - right).toBeCloseTo(20);
  });

  it("weights Line Anchor by the tracking delta selected for each gap", () => {
    const left = partialLineOriginForAnchor(0);
    const right = partialLineOriginForAnchor(100);

    expect(left - right).toBeCloseTo(20);
  });

  it("applies Line Spacing cumulatively from the second visual line", () => {
    const layer = createLayerForComposition("text", createBlankComposition());
    layer.text = "A\nA";
    layer.size = [200, 100];
    layer.textStyle = {
      fontFamily: "Inter",
      fontSize: 40,
      fontWeight: 700,
      alignment: "left",
      tracking: 0,
      leading: 48,
      strokeWidth: 0,
      strokeColor: [0, 0, 0, 1],
    };
    layer.textAnimator = {
      enabled: true,
      groups: [
        {
          id: "line-spacing",
          name: "Line Spacing",
          enabled: true,
          randomSeed: 0,
          selectors: [
            {
              id: "line-spacing-range",
              name: "Line Spacing Range",
              enabled: true,
              mode: "add",
              amount: staticValue(50),
              basedOn: "characters",
              kind: "range",
              units: "percentage",
              start: staticValue(0),
              end: staticValue(100),
              offset: staticValue(0),
              shape: "square",
              smoothness: staticValue(100),
              easeHigh: staticValue(0),
              easeLow: staticValue(0),
              randomizeOrder: false,
              randomSeed: 0,
            },
          ],
          properties: { lineSpacing: [staticValue(0), staticValue(12)] },
        },
      ],
    };
    const { context, operations } = recordingContext();

    drawTextLayer(context, layer, 200, 100);

    const glyphTranslations = operations.translate.mock.calls.filter(
      (call) => Number(call[0]) === 5,
    );
    expect(glyphTranslations.map((call) => Number(call[1]))).toEqual([0, 6]);
  });
});

function lineOriginForAnchor(lineAnchor: number): number {
  const layer = createLayerForComposition("text", createBlankComposition());
  layer.text = "ABC";
  layer.size = [200, 100];
  layer.textStyle = {
    fontFamily: "Inter",
    fontSize: 40,
    fontWeight: 700,
    alignment: "left",
    tracking: 0,
    leading: 48,
    strokeWidth: 0,
    strokeColor: [0, 0, 0, 1],
  };
  layer.textAnimator = {
    enabled: true,
    groups: [
      {
        id: "tracking",
        name: "Tracking",
        enabled: true,
        randomSeed: 0,
        selectors: [],
        properties: {
          tracking: staticValue(20),
          lineAnchor: staticValue(lineAnchor),
        },
      },
    ],
  };
  const { context, operations } = recordingContext();
  drawTextLayer(context, layer, 200, 100);
  return Number(operations.translate.mock.calls[1]?.[0]);
}

function partialLineOriginForAnchor(lineAnchor: number): number {
  const layer = createLayerForComposition("text", createBlankComposition());
  layer.text = "ABC";
  layer.size = [200, 100];
  layer.textStyle = {
    fontFamily: "Inter",
    fontSize: 40,
    fontWeight: 700,
    alignment: "left",
    tracking: 0,
    leading: 48,
    strokeWidth: 0,
    strokeColor: [0, 0, 0, 1],
  };
  layer.textAnimator = {
    enabled: true,
    groups: [
      {
        id: "partial-tracking",
        name: "Partial Tracking",
        enabled: true,
        randomSeed: 0,
        selectors: [
          {
            id: "first-character",
            name: "First Character",
            enabled: true,
            mode: "add",
            amount: staticValue(100),
            basedOn: "characters",
            kind: "range",
            units: "index",
            start: staticValue(0),
            end: staticValue(1),
            offset: staticValue(0),
            shape: "square",
            smoothness: staticValue(100),
            easeHigh: staticValue(0),
            easeLow: staticValue(0),
            randomizeOrder: false,
            randomSeed: 0,
          },
        ],
        properties: {
          tracking: staticValue(20),
          lineAnchor: staticValue(lineAnchor),
        },
      },
    ],
  };
  const { context, operations } = recordingContext();
  drawTextLayer(context, layer, 200, 100);
  return Number(operations.translate.mock.calls[1]?.[0]);
}

function recordingContext() {
  const operations = {
    fillText: vi.fn(),
    strokeText: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    transform: vi.fn(),
    translate: vi.fn(),
  };
  const styles = {
    fillStyle: [] as string[],
    filter: [] as string[],
    globalAlpha: [] as number[],
    lineWidth: [] as number[],
    strokeStyle: [] as string[],
  };
  let globalAlpha = 1;
  const context = {
    font: "",
    textAlign: "left",
    textBaseline: "middle",
    lineJoin: "round",
    miterLimit: 2,
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetY: 0,
    save: vi.fn(),
    restore: vi.fn(),
    measureText: (text: string) => ({ width: graphemeMeasure(text) }),
    ...operations,
  } as unknown as CanvasRenderingContext2D;
  for (const field of ["fillStyle", "filter", "lineWidth", "strokeStyle"] as const)
    Object.defineProperty(context, field, {
      get: () => styles[field][styles[field].length - 1],
      set: (value) => styles[field].push(value as never),
    });
  Object.defineProperty(context, "globalAlpha", {
    get: () => globalAlpha,
    set: (value: number) => {
      globalAlpha = value;
      styles.globalAlpha.push(value);
    },
  });
  return { context, operations, styles };
}
