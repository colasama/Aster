import { useId, useState } from "react";
import { ANTI_ALIASING_MODES, type AntiAliasingMode } from "../../core/rendering/anti-aliasing";
import type { Composition, Project } from "../../core/types";
import { open, save } from "../../desktop/api";
import type { Translate } from "../../i18n/core";
import { useI18n } from "../../i18n/react";
import {
  appendRenderSequenceName,
  DEFAULT_MP4_BITRATE_MBPS,
  DEFAULT_SEQUENCE_PATTERN,
  isValidSequencePattern,
  type RenderQueueJobOptions,
  type RenderQueueOutputKind,
  type RenderQueueOutputOptions,
  type RenderQueueRange,
} from "../../render-queue/render-job-builder";

export type RenderQualityPreset = "quick" | "standard" | "high" | "custom";

const QUALITY_PRESETS: Record<
  Exclude<RenderQualityPreset, "custom">,
  { bitrateMbps: string; antiAliasing: AntiAliasingMode | "app" }
> = {
  quick: { bitrateMbps: "5", antiAliasing: "off" },
  standard: { bitrateMbps: String(DEFAULT_MP4_BITRATE_MBPS), antiAliasing: "app" },
  high: { bitrateMbps: "50", antiAliasing: "ssaa4x" },
};

export interface RenderJobFormState {
  readonly outputKind: RenderQueueOutputKind;
  readonly bitrateMbps: string;
  readonly includeAudio: boolean;
  readonly fileNamePattern: string;
  readonly range: RenderQueueRange;
  readonly customStart: string;
  readonly customEnd: string;
  readonly antiAliasing: AntiAliasingMode | "app";
  readonly preset: RenderQualityPreset;
  readonly valid: boolean;
  setOutputKind(kind: RenderQueueOutputKind): void;
  setBitrateMbps(value: string): void;
  setIncludeAudio(value: boolean): void;
  setFileNamePattern(value: string): void;
  setRange(range: RenderQueueRange): void;
  setCustomStart(value: string): void;
  setCustomEnd(value: string): void;
  setAntiAliasing(mode: AntiAliasingMode | "app"): void;
  applyPreset(preset: Exclude<RenderQualityPreset, "custom">): void;
}

/** Controlled option state shared by the queue panel form and the top-bar render dialog. */
export function useRenderJobOptions(compositionDuration: number): RenderJobFormState {
  const [outputKind, setOutputKind] = useState<RenderQueueOutputKind>("mp4");
  const [bitrateMbps, setBitrateMbps] = useState(String(DEFAULT_MP4_BITRATE_MBPS));
  const [includeAudio, setIncludeAudio] = useState(false);
  const [fileNamePattern, setFileNamePattern] = useState(DEFAULT_SEQUENCE_PATTERN);
  const [range, setRange] = useState<RenderQueueRange>("workArea");
  const [customStart, setCustomStart] = useState("0");
  const [customEnd, setCustomEnd] = useState(String(compositionDuration));
  const [antiAliasing, setAntiAliasing] = useState<AntiAliasingMode | "app">("app");
  const bitrate = Number(bitrateMbps);
  const customStartSeconds = Number(customStart);
  const customEndSeconds = Number(customEnd);
  const preset: RenderQualityPreset =
    bitrateMbps === QUALITY_PRESETS.quick.bitrateMbps &&
    antiAliasing === QUALITY_PRESETS.quick.antiAliasing
      ? "quick"
      : bitrateMbps === QUALITY_PRESETS.standard.bitrateMbps &&
          antiAliasing === QUALITY_PRESETS.standard.antiAliasing
        ? "standard"
        : bitrateMbps === QUALITY_PRESETS.high.bitrateMbps &&
            antiAliasing === QUALITY_PRESETS.high.antiAliasing
          ? "high"
          : "custom";
  return {
    outputKind,
    bitrateMbps,
    includeAudio,
    fileNamePattern,
    range,
    customStart,
    customEnd,
    antiAliasing,
    preset,
    valid:
      (outputKind !== "mp4" || (bitrate >= 0.1 && bitrate <= 1_000)) &&
      (outputKind !== "pngSequence" || isValidSequencePattern(fileNamePattern)) &&
      (range !== "custom" ||
        (Number.isFinite(customStartSeconds) &&
          Number.isFinite(customEndSeconds) &&
          customStartSeconds >= 0 &&
          customEndSeconds > customStartSeconds)),
    setOutputKind,
    setBitrateMbps,
    setIncludeAudio,
    setFileNamePattern,
    setRange,
    setCustomStart,
    setCustomEnd,
    setAntiAliasing,
    applyPreset: (id) => {
      const values = QUALITY_PRESETS[id];
      setBitrateMbps(values.bitrateMbps);
      setAntiAliasing(values.antiAliasing);
    },
  };
}

/** Builds the job options the form describes; "app" anti-aliasing resolves to the app setting. */
export function renderJobRequest(
  form: RenderJobFormState,
  context: {
    composition: Composition;
    project: Project;
    projectRevision: number;
    appAntiAliasing: AntiAliasingMode;
    currentTime: number;
  },
): Omit<RenderQueueJobOptions, "destination"> {
  const output: RenderQueueOutputOptions =
    form.outputKind === "mp4"
      ? { kind: "mp4", bitrateMbps: Number(form.bitrateMbps), includeAudio: form.includeAudio }
      : form.outputKind === "pngSequence"
        ? { kind: "pngSequence", fileNamePattern: form.fileNamePattern }
        : { kind: "still", format: "png" };
  return {
    composition: context.composition,
    project: context.project,
    projectRevision: context.projectRevision,
    antiAliasing: form.antiAliasing === "app" ? context.appAntiAliasing : form.antiAliasing,
    output,
    range: form.outputKind === "still" ? "currentFrame" : form.range,
    customRange: { start: Number(form.customStart), end: Number(form.customEnd) },
    currentTime: context.currentTime,
  };
}

export async function chooseRenderDestination(
  kind: RenderQueueOutputKind,
  compositionName: string,
  t: Translate,
): Promise<string | undefined> {
  const safeName = compositionName.replace(/[<>:"/\\|?*]/g, "-") || "render";
  if (kind === "pngSequence") {
    const parent = await open({ directory: true, title: t("renderQueue.chooseSequenceParent") });
    return typeof parent === "string"
      ? appendRenderSequenceName(parent, compositionName)
      : undefined;
  }
  const extension = kind === "mp4" ? "mp4" : "png";
  return (
    (await save({
      title: t("renderQueue.chooseOutput"),
      defaultPath: `${safeName}.${extension}`,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    })) ?? undefined
  );
}

/** Conditional output-module fields shared between the queue add form and the render dialog. */
export function RenderJobFields({
  disabled,
  options,
}: {
  readonly disabled: boolean;
  readonly options: RenderJobFormState;
}) {
  const { t } = useI18n();
  const bitrateListId = useId();
  return (
    <>
      <label>
        <span>{t("renderQueue.preset")}</span>
        <select
          disabled={disabled}
          onChange={(event) => {
            const preset = event.target.value;
            if (preset !== "custom") options.applyPreset(preset as "quick" | "standard" | "high");
          }}
          value={options.preset}
        >
          <option value="quick">{t("renderQueue.preset.quick")}</option>
          <option value="standard">{t("renderQueue.preset.standard")}</option>
          <option value="high">{t("renderQueue.preset.high")}</option>
          <option value="custom">{t("renderQueue.preset.custom")}</option>
        </select>
      </label>
      <label>
        <span>{t("renderQueue.format")}</span>
        <select
          disabled={disabled}
          onChange={(event) => options.setOutputKind(event.target.value as RenderQueueOutputKind)}
          value={options.outputKind}
        >
          <option value="mp4">{t("renderQueue.format.mp4")}</option>
          <option value="pngSequence">{t("renderQueue.format.pngSequence")}</option>
          <option value="still">{t("renderQueue.format.still")}</option>
        </select>
      </label>
      {options.outputKind === "mp4" ? (
        <>
          <label>
            <span>{t("renderQueue.bitrate")}</span>
            <input
              disabled={disabled}
              list={bitrateListId}
              max={1_000}
              min={0.1}
              onChange={(event) => options.setBitrateMbps(event.target.value)}
              step={0.1}
              type="number"
              value={options.bitrateMbps}
            />
            <datalist id={bitrateListId}>
              <option value="5" />
              <option value="20" />
              <option value="50" />
            </datalist>
          </label>
          <label className="render-queue-check">
            <input
              checked={options.includeAudio}
              disabled={disabled}
              onChange={(event) => options.setIncludeAudio(event.target.checked)}
              type="checkbox"
            />
            <span>{t("renderQueue.includeAudio")}</span>
          </label>
        </>
      ) : options.outputKind === "pngSequence" ? (
        <label>
          <span>{t("renderQueue.fileName")}</span>
          <input
            disabled={disabled}
            onChange={(event) => options.setFileNamePattern(event.target.value)}
            type="text"
            value={options.fileNamePattern}
          />
        </label>
      ) : null}
      <label>
        <span>{t("renderQueue.range")}</span>
        <select
          disabled={disabled || options.outputKind === "still"}
          onChange={(event) => options.setRange(event.target.value as RenderQueueRange)}
          value={options.outputKind === "still" ? "currentFrame" : options.range}
        >
          <option value="workArea">{t("renderQueue.range.workArea")}</option>
          <option value="composition">{t("renderQueue.range.composition")}</option>
          <option value="currentFrame">{t("renderQueue.range.currentFrame")}</option>
          <option value="custom">{t("renderQueue.range.custom")}</option>
        </select>
      </label>
      {options.range === "custom" && options.outputKind !== "still" ? (
        <>
          <label>
            <span>{t("renderQueue.rangeStart")}</span>
            <input
              disabled={disabled}
              min={0}
              onChange={(event) => options.setCustomStart(event.target.value)}
              step={0.001}
              type="number"
              value={options.customStart}
            />
          </label>
          <label>
            <span>{t("renderQueue.rangeEnd")}</span>
            <input
              disabled={disabled}
              min={0}
              onChange={(event) => options.setCustomEnd(event.target.value)}
              step={0.001}
              type="number"
              value={options.customEnd}
            />
          </label>
        </>
      ) : null}
      <label>
        <span>{t("renderQueue.antiAliasing")}</span>
        <select
          disabled={disabled}
          onChange={(event) =>
            options.setAntiAliasing(event.target.value as AntiAliasingMode | "app")
          }
          value={options.antiAliasing}
        >
          <option value="app">{t("renderQueue.antiAliasing.app")}</option>
          {ANTI_ALIASING_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`renderQueue.antiAliasing.${mode}`)}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
