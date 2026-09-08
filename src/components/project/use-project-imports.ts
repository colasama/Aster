import { useRef, useState } from "react";
import type { Operation } from "../../core/editing/operations";
import {
  createMediaLayerFromFile,
  type ImportMediaKind,
  importMediaLayer,
} from "../../core/media/assets";
import { activeComposition } from "../../core/project/project";
import { relinkProjectSource } from "../../core/project/project-file";
import type { FootageSource, Id } from "../../core/types";
import { convertFileSrc, discoverImageSequence, isDesktopRuntime, open } from "../../desktop/api";
import { reportUiError } from "../../errors/report-ui-error";
import type { UiErrorCode } from "../../i18n/errors";
import { useI18n } from "../../i18n/react";
import {
  type AdvancedImportResult,
  type createBrowserSequenceInput,
  createImageSequenceImport,
  imageDimensionsFromUrl,
  importPsdFile,
  importSvgFile,
} from "../../importers/advanced-import";
import { detectImageSequence } from "../../importers/image-sequence";
import type { MissingSequenceFramePolicy } from "../../importers/image-sequence-runtime";
import { mediaImportRuntime, type RuntimeSequenceFile } from "../../importers/media-import-runtime";
import type { PsdImportMode } from "../../importers/psd-composition";
import { useEditor } from "../../state/editor-store";

export function useProjectImports(
  destinationFolderId: Id | undefined,
  selectedSource: FootageSource | undefined,
  onImported: (folderId?: Id) => void,
) {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const composition = activeComposition(state.project);
  const [assetError, setAssetError] = useState<UiErrorCode>();
  const [assetErrorDetail, setAssetErrorDetail] = useState<string>();
  const [assetWarningCount, setAssetWarningCount] = useState(0);
  const [psdImportMode, setPsdImportMode] = useState<PsdImportMode>("merged");
  const [sequenceFrameRate, setSequenceFrameRate] = useState({ numerator: 24, denominator: 1 });
  const [missingFramePolicy, setMissingFramePolicy] =
    useState<MissingSequenceFramePolicy>("holdPrevious");
  const imagePickerRef = useRef<HTMLInputElement>(null);
  const svgPickerRef = useRef<HTMLInputElement>(null);
  const psdPickerRef = useRef<HTMLInputElement>(null);
  const sequencePickerRef = useRef<HTMLInputElement>(null);
  const importMedia = async (kind: ImportMediaKind, file: File, folderId?: Id) => {
    try {
      setAssetError(undefined);
      const imported = await createMediaLayerFromFile(kind, file, composition, state.currentTime);
      commitMediaImport(imported, folderId);
    } catch (error) {
      reportMediaImportError(kind, error, file.name);
    }
  };
  const chooseMedia = async (kind: ImportMediaKind, folderId = destinationFolderId) => {
    try {
      setAssetError(undefined);
      const imported = await importMediaLayer(kind, composition, state.currentTime);
      if (imported) commitMediaImport(imported, folderId);
    } catch (error) {
      reportMediaImportError(kind, error);
    }
  };
  const commitMediaImport = (
    imported: Awaited<ReturnType<typeof createMediaLayerFromFile>>,
    folderId?: Id,
  ) => {
    const existing = state.project.sources.find(
      (source) => source.contentIdentity === imported.source.contentIdentity,
    );
    const source = existing ?? imported.source;
    if (existing) mediaImportRuntime.move(imported.source.id, existing.id);
    const layer = { ...imported.layer, sourceId: source.id };
    dispatch({
      type: "operation",
      operations: [
        ...(!existing ? ([{ type: "addSource", source }] as const) : []),
        { type: "addLayer", layer },
        ...(folderId ? ([{ type: "moveProjectItem", itemId: source.id, folderId }] as const) : []),
      ],
      select: [layer.id],
    });
    onImported(folderId);
  };
  const reportMediaImportError = (kind: ImportMediaKind, error: unknown, assetName?: string) => {
    const code =
      kind === "image" ? "assetImageImport" : kind === "video" ? "assetVideoImport" : "mediaImport";
    setAssetError(code);
    reportUiError(t, code, error, {
      scope: {
        area: "asset",
        projectId: state.project.id,
        compositionId: composition.id,
        ...(assetName ? { assetName } : {}),
      },
    });
  };
  const commitAdvancedImport = (result: AdvancedImportResult, folderId?: Id) => {
    const operations: Operation[] = [
      ...result.sources.map((source) => ({ type: "addSource" as const, source })),
      ...(result.composition
        ? [{ type: "addComposition" as const, composition: result.composition, activate: true }]
        : result.layers.map((layer) => ({ type: "addLayer" as const, layer }))),
      ...(folderId
        ? [
            ...result.sources.map((source) => ({
              type: "moveProjectItem" as const,
              itemId: source.id,
              folderId,
            })),
            ...(result.composition
              ? [
                  {
                    type: "moveProjectItem" as const,
                    itemId: result.composition.id,
                    folderId,
                  },
                ]
              : []),
          ]
        : []),
    ];
    dispatch({
      type: "operation",
      operations,
      select: result.layers[0] ? [result.layers[0].id] : [],
    });
    setAssetError(undefined);
    setAssetErrorDetail(undefined);
    setAssetWarningCount(result.warnings.length);
    onImported(folderId);
  };
  const reportAdvancedImportError = (error: unknown, assetName?: string) => {
    setAssetError("assetImageImport");
    setAssetWarningCount(0);
    setAssetErrorDetail(
      (error instanceof Error ? error.message : String(error)).slice(0, 500) ||
        t("project.asset.importUnknown"),
    );
    reportUiError(t, "assetImageImport", error, {
      scope: {
        area: "asset",
        projectId: state.project.id,
        compositionId: composition.id,
        ...(assetName ? { assetName } : {}),
      },
    });
  };
  const importSvg = async (
    file: Pick<File, "name" | "text"> & { runtimeUrl?: string },
    folderId = destinationFolderId,
  ) => {
    try {
      setAssetError(undefined);
      setAssetErrorDetail(undefined);
      commitAdvancedImport(await importSvgFile(file, composition, state.currentTime), folderId);
    } catch (error) {
      reportAdvancedImportError(error, file.name);
    }
  };
  const importPsd = async (
    file: Pick<File, "name" | "arrayBuffer"> & { runtimeUrl?: string; sourcePath?: string },
    folderId = destinationFolderId,
  ) => {
    try {
      setAssetError(undefined);
      setAssetErrorDetail(undefined);
      commitAdvancedImport(
        await importPsdFile(file, psdImportMode, composition, state.currentTime),
        folderId,
      );
    } catch (error) {
      reportAdvancedImportError(error, file.name);
    }
  };
  const importSequence = async (
    input: Awaited<ReturnType<typeof createBrowserSequenceInput>>,
    folderId = destinationFolderId,
  ) => {
    let committed = false;
    try {
      setAssetError(undefined);
      setAssetErrorDetail(undefined);
      const firstFrame = input.selection.frames[0];
      if (!firstFrame) throw new Error("Image sequence contains no readable frames");
      const dimensions = await imageDimensionsFromUrl(firstFrame.file.url);
      const result = createImageSequenceImport(
        input,
        dimensions,
        { frameRate: sequenceFrameRate, missingFramePolicy },
        composition,
        state.currentTime,
      );
      committed = true;
      commitAdvancedImport(result, folderId);
    } catch (error) {
      reportAdvancedImportError(error, input.selection.pattern);
    } finally {
      if (!committed) input.dispose?.();
    }
  };
  const chooseSvg = async (folderId = destinationFolderId) => {
    if (!isDesktopRuntime()) {
      svgPickerRef.current?.click();
      return;
    }
    const path = await open({
      title: t("project.asset.chooseSvg"),
      filters: [{ name: "SVG", extensions: ["svg"] }],
    });
    if (typeof path !== "string") return;
    const url = convertFileSrc(path);
    await importSvg(
      {
        name: fileNameFromPath(path),
        runtimeUrl: url,
        text: () => fetchImportResponse(url).then((response) => response.text()),
      },
      folderId,
    );
  };
  const choosePsd = async (folderId = destinationFolderId) => {
    if (!isDesktopRuntime()) {
      psdPickerRef.current?.click();
      return;
    }
    const path = await open({
      title: t("project.asset.choosePsd"),
      filters: [{ name: "Photoshop", extensions: ["psd"] }],
    });
    if (typeof path !== "string") return;
    const url = convertFileSrc(path);
    await importPsd(
      {
        name: fileNameFromPath(path),
        runtimeUrl: url,
        sourcePath: path,
        arrayBuffer: () => fetchImportResponse(url).then((response) => response.arrayBuffer()),
      },
      folderId,
    );
  };
  const chooseSequence = async (folderId = destinationFolderId) => {
    let selectedPath: string | undefined;
    if (!isDesktopRuntime()) {
      sequencePickerRef.current?.click();
      return;
    }
    try {
      const path = await open({
        title: t("project.asset.chooseSequence"),
        filters: [
          {
            name: t("project.asset.imageFrames"),
            extensions: ["png", "jpg", "jpeg", "webp", "avif", "tif", "tiff", "bmp", "gif"],
          },
        ],
      });
      if (typeof path !== "string") return;
      selectedPath = path;
      const files = await discoverImageSequence(path);
      const runtimeFiles = files.map(
        (file) => ({ ...file, url: convertFileSrc(file.path) }) satisfies RuntimeSequenceFile,
      );
      await importSequence(
        { selection: detectImageSequence(runtimeFiles, fileNameFromPath(path)) },
        folderId,
      );
    } catch (error) {
      reportAdvancedImportError(error, selectedPath ? fileNameFromPath(selectedPath) : undefined);
    }
  };
  const relinkAsset = async (selectedAsset = selectedSource) => {
    if (!selectedAsset) return;
    try {
      setAssetError(undefined);
      const source = await relinkProjectSource(selectedAsset);
      if (source)
        dispatch({
          type: "operation",
          operations: [{ type: "reloadSource", sourceId: selectedAsset.id, source }],
        });
    } catch (error) {
      setAssetError("assetRelink");
      reportUiError(t, "assetRelink", error, {
        scope: {
          area: "asset",
          projectId: state.project.id,
          assetName: selectedAsset.name,
        },
      });
    }
  };

  return {
    assetError,
    assetErrorDetail,
    assetWarningCount,
    psdImportMode,
    setPsdImportMode,
    sequenceFrameRate,
    setSequenceFrameRate,
    missingFramePolicy,
    setMissingFramePolicy,
    imagePickerRef,
    svgPickerRef,
    psdPickerRef,
    sequencePickerRef,
    importMedia,
    chooseMedia,
    importSvg,
    importPsd,
    importSequence,
    chooseSvg,
    choosePsd,
    chooseSequence,
    reportAdvancedImportError,
    relinkAsset,
  };
}
function fileNameFromPath(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "Imported asset";
}

async function fetchImportResponse(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Asset request failed with HTTP ${response.status}`);
  return response;
}
