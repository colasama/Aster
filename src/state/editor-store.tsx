import {
  createContext,
  type Dispatch,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { recordCommandMarker, recordOperations } from "../core/editing/command-log";
import { applyOperations, cloneProjectSnapshot, type Operation } from "../core/editing/operations";
import { activeComposition, createDemoProject } from "../core/project/project";
import { storeRecoverySnapshot } from "../core/project/project-file";
import type { Id, Project, RendererMetrics } from "../core/types";
import { isDesktopRuntime, migrateLegacyPreferences } from "../desktop/api";
import { APP_PREFERENCES_CHANGED_EVENT, type UserPreferencePatch } from "../desktop/preferences";
import { DEFAULT_VIEWPORT_ZOOM, normalizeViewportZoom } from "../ui/viewport-zoom";

export interface EditorState {
  project: Project;
  /** Monotonic live-editor revision used to reject stale agent workspaces. */
  projectRevision: number;
  /** Revision written to the primary project file, or null for an untitled/recovered document. */
  savedProjectRevision: number | null;
  autosave: {
    status: "idle" | "saving" | "saved" | "error";
    revision?: number;
    at?: string;
  };
  selection: Id[];
  selectedKeyframes: Id[];
  currentTime: number;
  /** Changes only for explicit seeks, never for playback acknowledgements. */
  seekRevision?: number;
  playing: boolean;
  timelineZoom: number;
  viewportZoom: number;
  previewQuality: 1 | 0.5 | 0.25;
  gpuMemoryBudgetMb: "auto" | 32 | 64 | 128 | 256 | 512;
  leftTab: "project" | "effects";
  rightTab: "properties" | "ai";
  bottomMode: "timeline" | "graph";
  activeTool: "select" | "hand" | "rotate" | "shape" | "ellipse" | "pen" | "text" | "3d";
  showGrid: boolean;
  showGuides: boolean;
  showOrigin: boolean;
  showLayerControls: boolean;
  history: { past: Project[]; future: Project[] };
  metrics: RendererMetrics;
  auditLog: Array<{
    id: Id;
    at: string;
    source: "ai" | "user";
    summary: string;
    operationTypes: string[];
  }>;
}

export type EditorAction =
  | {
      type: "operation";
      operations: Operation[];
      select?: Id[];
      historyBase?: Project;
      metadata?: { source: "ai" | "user"; summary: string };
    }
  | { type: "previewOperation"; operations: Operation[] }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "select"; ids: Id[] }
  | { type: "selectKeyframes"; ids: Id[] }
  | { type: "setTime"; time: number }
  | { type: "setPlaybackTime"; time: number }
  | { type: "setPlaying"; playing: boolean }
  | { type: "setTimelineZoom"; zoom: number }
  | { type: "setViewportZoom"; zoom: number }
  | { type: "setPreviewQuality"; quality: EditorState["previewQuality"] }
  | { type: "setGpuMemoryBudget"; budget: EditorState["gpuMemoryBudgetMb"] }
  | { type: "setLeftTab"; tab: EditorState["leftTab"] }
  | { type: "setRightTab"; tab: EditorState["rightTab"] }
  | { type: "setBottomMode"; mode: EditorState["bottomMode"] }
  | { type: "setActiveTool"; tool: EditorState["activeTool"] }
  | { type: "toggleView"; view: "grid" | "guides" | "origin" | "layerControls" }
  | { type: "setMetrics"; metrics: RendererMetrics }
  | { type: "setActiveComposition"; compositionId: Id }
  | { type: "loadProject"; project: Project; markSaved?: boolean }
  | { type: "markSaved"; projectId: Id; revision: number }
  | { type: "autosaveStarted"; projectId: Id; revision: number }
  | { type: "autosaveCompleted"; projectId: Id; revision: number; at: string }
  | { type: "autosaveFailed"; projectId: Id; revision: number };

const initialMetrics: RendererMetrics = {
  fps: 0,
  frameMs: 0,
  cpuMs: 0,
  drawCalls: 0,
  passCount: 0,
  dirtyNodes: 0,
  cacheHitRate: 0,
  estimatedVramMb: 0,
  transientTextureCount: 0,
};

export function createInitialState(): EditorState {
  const project = createDemoProject();
  return {
    selection: [project.compositions[0].layers[0].id],
    selectedKeyframes: [],
    project,
    projectRevision: 0,
    savedProjectRevision: 0,
    autosave: { status: "idle" },
    currentTime: 0.72,
    playing: false,
    timelineZoom: 1,
    viewportZoom: DEFAULT_VIEWPORT_ZOOM,
    previewQuality: 1,
    gpuMemoryBudgetMb: readGpuMemoryBudget(),
    leftTab: "project",
    rightTab: "properties",
    bottomMode: "timeline",
    activeTool: "select",
    showGrid: false,
    showGuides: true,
    showOrigin: true,
    showLayerControls: true,
    history: { past: [], future: [] },
    metrics: initialMetrics,
    auditLog: [],
  };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "operation": {
      const project = applyOperations(state.project, action.operations);
      const entry = recordOperations(project, action.operations, action.metadata);
      return {
        ...state,
        project,
        projectRevision: state.projectRevision + 1,
        autosave: { status: "idle" },
        selection: action.select ?? state.selection,
        ...(project.activeCompositionId !== state.project.activeCompositionId
          ? compositionEntryState(project, state.seekRevision)
          : {}),
        history: {
          past: [...state.history.past.slice(-99), action.historyBase ?? state.project],
          future: [],
        },
        auditLog:
          action.metadata?.source === "ai" ? [...state.auditLog.slice(-99), entry] : state.auditLog,
      };
    }
    case "previewOperation":
      return {
        ...state,
        project: applyOperations(state.project, action.operations),
        projectRevision: state.projectRevision + 1,
        autosave: { status: "idle" },
      };
    case "undo": {
      const project = state.history.past[state.history.past.length - 1];
      if (!project) return state;
      const restored = cloneProjectSnapshot(project);
      restored.commandLog = state.project.commandLog;
      recordCommandMarker(restored, "undo", "Undo transaction");
      return {
        ...state,
        project: restored,
        projectRevision: state.projectRevision + 1,
        autosave: { status: "idle" },
        selection: validSelection(restored, state.selection, true),
        ...(restored.activeCompositionId !== state.project.activeCompositionId
          ? compositionEntryState(restored, state.seekRevision)
          : {}),
        history: {
          past: state.history.past.slice(0, -1),
          future: [state.project, ...state.history.future],
        },
      };
    }
    case "redo": {
      const [project, ...future] = state.history.future;
      if (!project) return state;
      const restored = cloneProjectSnapshot(project);
      restored.commandLog = state.project.commandLog;
      recordCommandMarker(restored, "redo", "Redo transaction");
      return {
        ...state,
        project: restored,
        projectRevision: state.projectRevision + 1,
        autosave: { status: "idle" },
        selection: validSelection(restored, state.selection, true),
        ...(restored.activeCompositionId !== state.project.activeCompositionId
          ? compositionEntryState(restored, state.seekRevision)
          : {}),
        history: { past: [...state.history.past, state.project], future },
      };
    }
    case "select":
      return { ...state, selection: action.ids };
    case "selectKeyframes":
      return { ...state, selectedKeyframes: action.ids };
    case "setTime":
      return {
        ...state,
        currentTime: Math.max(0, action.time),
        seekRevision: (state.seekRevision ?? 0) + 1,
      };
    case "setPlaybackTime":
      return { ...state, currentTime: Math.max(0, action.time) };
    case "setPlaying":
      return { ...state, playing: action.playing };
    case "setTimelineZoom":
      return { ...state, timelineZoom: Math.max(0.5, Math.min(8, action.zoom)) };
    case "setViewportZoom":
      return { ...state, viewportZoom: normalizeViewportZoom(action.zoom) };
    case "setPreviewQuality":
      return { ...state, previewQuality: action.quality };
    case "setGpuMemoryBudget":
      return { ...state, gpuMemoryBudgetMb: action.budget };
    case "setLeftTab":
      return { ...state, leftTab: action.tab };
    case "setRightTab":
      return { ...state, rightTab: action.tab };
    case "setBottomMode":
      return { ...state, bottomMode: action.mode };
    case "setActiveTool":
      return { ...state, activeTool: action.tool };
    case "toggleView": {
      const key = {
        grid: "showGrid",
        guides: "showGuides",
        origin: "showOrigin",
        layerControls: "showLayerControls",
      }[action.view] as "showGrid" | "showGuides" | "showOrigin" | "showLayerControls";
      return { ...state, [key]: !state[key] };
    }
    case "setMetrics":
      return { ...state, metrics: action.metrics };
    case "setActiveComposition": {
      const composition = state.project.compositions.find(
        (candidate) => candidate.id === action.compositionId,
      );
      if (!composition) return state;
      const project = applyOperations(state.project, [
        { type: "setActiveComposition", compositionId: action.compositionId },
      ]);
      recordOperations(project, [
        { type: "setActiveComposition", compositionId: action.compositionId },
      ]);
      return {
        ...state,
        project,
        projectRevision: state.projectRevision + 1,
        autosave: { status: "idle" },
        ...compositionEntryState(project, state.seekRevision),
        history: { past: [...state.history.past.slice(-99), state.project], future: [] },
      };
    }
    case "loadProject": {
      const initial = createInitialState();
      return {
        ...initial,
        project: action.project,
        projectRevision: 0,
        savedProjectRevision: action.markSaved === true ? 0 : null,
        autosave: { status: "idle" },
        auditLog: action.project.commandLog.filter((entry) => entry.source === "ai").slice(-100),
        ...compositionEntryState(action.project, state.seekRevision),
      };
    }
    case "markSaved":
      if (state.project.id !== action.projectId || action.revision > state.projectRevision)
        return state;
      return { ...state, savedProjectRevision: action.revision, autosave: { status: "idle" } };
    case "autosaveStarted":
      if (state.project.id !== action.projectId || action.revision > state.projectRevision)
        return state;
      return { ...state, autosave: { status: "saving", revision: action.revision } };
    case "autosaveCompleted":
      if (state.project.id !== action.projectId || action.revision > state.projectRevision)
        return state;
      return {
        ...state,
        autosave: { status: "saved", revision: action.revision, at: action.at },
      };
    case "autosaveFailed":
      if (state.project.id !== action.projectId || action.revision > state.projectRevision)
        return state;
      return { ...state, autosave: { status: "error", revision: action.revision } };
  }
}

export function isProjectDirty(
  state: Pick<EditorState, "projectRevision" | "savedProjectRevision">,
) {
  return state.savedProjectRevision !== state.projectRevision;
}

function readGpuMemoryBudget(): EditorState["gpuMemoryBudgetMb"] {
  if (typeof window === "undefined") return "auto";
  const value = window.localStorage.getItem("aster.gpuMemoryBudgetMb") ?? "auto";
  if (value === "auto") return value;
  const megabytes = Number(value);
  return [32, 64, 128, 256, 512].includes(megabytes)
    ? (megabytes as Exclude<EditorState["gpuMemoryBudgetMb"], "auto">)
    : "auto";
}

function compositionEntryState(
  project: Project,
  seekRevision = 0,
): Pick<
  EditorState,
  "selection" | "selectedKeyframes" | "currentTime" | "playing" | "seekRevision"
> {
  const composition = activeComposition(project);
  const start = composition.workArea?.start ?? 0;
  return {
    selection: validSelection(project, [], true),
    selectedKeyframes: [],
    currentTime: Number.isFinite(start) && start >= 0 && start < composition.duration ? start : 0,
    playing: false,
    seekRevision: seekRevision + 1,
  };
}

function validSelection(project: Project, selection: Id[], fallback: boolean): Id[] {
  const composition =
    project.compositions.find((candidate) => candidate.id === project.activeCompositionId) ??
    project.compositions[0];
  if (!composition) return [];
  const ids = new Set(composition.layers.map((layer) => layer.id));
  const valid = selection.filter((id) => ids.has(id));
  if (valid.length > 0 || !fallback) return valid;
  return composition.layers[0] ? [composition.layers[0].id] : [];
}

const EditorContext = createContext<
  { state: EditorState; dispatch: Dispatch<EditorAction> } | undefined
>(undefined);

type EditorDocumentState = Pick<
  EditorState,
  "project" | "selection" | "selectedKeyframes" | "showLayerControls"
>;
const EditorDocumentContext = createContext<
  { state: EditorDocumentState; dispatch: Dispatch<EditorAction> } | undefined
>(undefined);

export function EditorProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(editorReducer, undefined, createInitialState);
  const [autosaveSeconds, setAutosaveSeconds] = useState(readAutosaveSeconds);
  const latestState = useRef(state);
  const autosaveInFlight = useRef(false);
  const dirty = isProjectDirty(state);
  latestState.current = state;

  const persistRecovery = useCallback(async (candidate: EditorState) => {
    if (
      autosaveInFlight.current ||
      !isProjectDirty(candidate) ||
      candidate.projectRevision === 0 ||
      (candidate.autosave.status === "saved" &&
        candidate.autosave.revision === candidate.projectRevision)
    )
      return;
    const projectId = candidate.project.id;
    const revision = candidate.projectRevision;
    autosaveInFlight.current = true;
    dispatch({ type: "autosaveStarted", projectId, revision });
    try {
      await storeRecoverySnapshot(candidate.project);
      dispatch({
        type: "autosaveCompleted",
        projectId,
        revision,
        at: new Date().toISOString(),
      });
    } catch {
      dispatch({ type: "autosaveFailed", projectId, revision });
    } finally {
      autosaveInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void migrateLegacyPreferences(readLegacyRendererPreferences())
      .then((preferences) => {
        try {
          localStorage.setItem("aster.autosaveSeconds", String(preferences.autosaveSeconds));
          localStorage.setItem("aster.reducedMotion", String(preferences.reducedMotion));
          localStorage.setItem("aster.gpuMemoryBudgetMb", String(preferences.gpuMemoryBudgetMb));
          if (preferences.locale) localStorage.setItem("aster.locale", preferences.locale);
          setAutosaveSeconds(preferences.autosaveSeconds);
        } catch {
          // Electron preferences remain authoritative when renderer storage is unavailable.
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const handlePreferencesChanged = () => setAutosaveSeconds(readAutosaveSeconds());
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged);
    return () =>
      window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged);
  }, []);

  useEffect(() => {
    if (!dirty || state.projectRevision === 0) return;
    if (state.autosave.status === "saved" && state.autosave.revision === state.projectRevision)
      return;
    if (autosaveSeconds <= 0) return;
    const timer = window.setTimeout(
      () => void persistRecovery(latestState.current),
      autosaveSeconds * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [
    dirty,
    persistRecovery,
    autosaveSeconds,
    state.autosave.revision,
    state.autosave.status,
    state.projectRevision,
  ]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (autosaveSeconds > 0) void persistRecovery(latestState.current);
    }, 60_000);
    const flushWhenHidden = () => {
      if (autosaveSeconds > 0 && document.visibilityState === "hidden")
        void persistRecovery(latestState.current);
    };
    const warnBeforeBrowserUnload = (event: BeforeUnloadEvent) => {
      if (!isProjectDirty(latestState.current)) return;
      if (autosaveSeconds > 0) void persistRecovery(latestState.current);
      if (!isDesktopRuntime()) event.preventDefault();
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("beforeunload", warnBeforeBrowserUnload);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("beforeunload", warnBeforeBrowserUnload);
    };
  }, [autosaveSeconds, persistRecovery]);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  // Timeline rows do not depend on the playback clock or profiler samples.
  const documentValue = useMemo(
    () => ({
      state: {
        project: state.project,
        selection: state.selection,
        selectedKeyframes: state.selectedKeyframes,
        showLayerControls: state.showLayerControls,
      },
      dispatch,
    }),
    [state.project, state.selection, state.selectedKeyframes, state.showLayerControls],
  );
  return (
    <EditorContext.Provider value={value}>
      <EditorDocumentContext.Provider value={documentValue}>
        {children}
      </EditorDocumentContext.Provider>
    </EditorContext.Provider>
  );
}

function readAutosaveSeconds(): number {
  try {
    const seconds = Number(localStorage.getItem("aster.autosaveSeconds") ?? 30);
    return seconds === 0 || seconds === 15 || seconds === 30 || seconds === 60 ? seconds : 30;
  } catch {
    return 30;
  }
}

function readLegacyRendererPreferences(): UserPreferencePatch {
  try {
    const autosaveValue = localStorage.getItem("aster.autosaveSeconds");
    const autosave = Number(autosaveValue);
    const gpuBudget = localStorage.getItem("aster.gpuMemoryBudgetMb");
    const locale = localStorage.getItem("aster.locale");
    const patch: UserPreferencePatch = {
      ...(autosaveValue !== null &&
      (autosave === 0 || autosave === 15 || autosave === 30 || autosave === 60)
        ? { autosaveSeconds: autosave }
        : {}),
      ...(localStorage.getItem("aster.reducedMotion") === "true" ? { reducedMotion: true } : {}),
      ...(locale === "en-US" || locale === "zh-CN" ? { locale } : {}),
    };
    if (gpuBudget === "auto") patch.gpuMemoryBudgetMb = "auto";
    else {
      const megabytes = Number(gpuBudget);
      if (
        megabytes === 32 ||
        megabytes === 64 ||
        megabytes === 128 ||
        megabytes === 256 ||
        megabytes === 512
      )
        patch.gpuMemoryBudgetMb = megabytes;
    }
    return patch;
  } catch {
    return {};
  }
}

export function useEditor() {
  const context = useContext(EditorContext);
  if (!context) throw new Error("useEditor must be used inside EditorProvider");
  return context;
}

export function useEditorDocument() {
  const context = useContext(EditorDocumentContext);
  if (!context) throw new Error("useEditorDocument must be used inside EditorProvider");
  return context;
}
