import {
  createContext,
  type Dispatch,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from "react";
import { recordCommandMarker, recordOperations } from "../core/command-log";
import { applyOperations, type Operation } from "../core/operations";
import { createDemoProject } from "../core/project";
import { storeRecoverySnapshot } from "../core/project-file";
import type { Id, Project, RendererMetrics } from "../core/types";

export interface EditorState {
  project: Project;
  /** Monotonic live-editor revision used to reject stale agent workspaces. */
  projectRevision: number;
  selection: Id[];
  selectedKeyframes: Id[];
  currentTime: number;
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
  | { type: "loadProject"; project: Project };

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
    currentTime: 0.72,
    playing: false,
    timelineZoom: 1,
    viewportZoom: 0.22,
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
        selection: action.select ?? state.selection,
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
      };
    case "undo": {
      const project = state.history.past[state.history.past.length - 1];
      if (!project) return state;
      const restored = structuredClone(project);
      restored.commandLog = state.project.commandLog;
      recordCommandMarker(restored, "undo", "Undo transaction");
      return {
        ...state,
        project: restored,
        projectRevision: state.projectRevision + 1,
        selection: validSelection(restored, state.selection, true),
        history: {
          past: state.history.past.slice(0, -1),
          future: [state.project, ...state.history.future],
        },
      };
    }
    case "redo": {
      const [project, ...future] = state.history.future;
      if (!project) return state;
      const restored = structuredClone(project);
      restored.commandLog = state.project.commandLog;
      recordCommandMarker(restored, "redo", "Redo transaction");
      return {
        ...state,
        project: restored,
        projectRevision: state.projectRevision + 1,
        selection: validSelection(restored, state.selection, true),
        history: { past: [...state.history.past, state.project], future },
      };
    }
    case "select":
      return { ...state, selection: action.ids };
    case "selectKeyframes":
      return { ...state, selectedKeyframes: action.ids };
    case "setTime":
      return { ...state, currentTime: Math.max(0, action.time) };
    case "setPlaying":
      return { ...state, playing: action.playing };
    case "setTimelineZoom":
      return { ...state, timelineZoom: Math.max(0.5, Math.min(8, action.zoom)) };
    case "setViewportZoom":
      return { ...state, viewportZoom: Math.max(0.05, Math.min(2, action.zoom)) };
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
        selection: composition.layers[0] ? [composition.layers[0].id] : [],
        selectedKeyframes: [],
        currentTime: 0,
        playing: false,
        history: { past: [...state.history.past.slice(-99), state.project], future: [] },
      };
    }
    case "loadProject": {
      const initial = createInitialState();
      return {
        ...initial,
        project: action.project,
        projectRevision: 0,
        auditLog: action.project.commandLog.filter((entry) => entry.source === "ai").slice(-100),
        selection: validSelection(action.project, [], true),
        currentTime: 0,
      };
    }
  }
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

export function EditorProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(editorReducer, undefined, createInitialState);
  useEffect(() => {
    if (!state.history.past.length) return;
    const seconds = Number(localStorage.getItem("aster.autosaveSeconds") ?? 30);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const timer = window.setTimeout(() => storeRecoverySnapshot(state.project), seconds * 1000);
    return () => window.clearTimeout(timer);
  }, [state.history.past.length, state.project]);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor() {
  const context = useContext(EditorContext);
  if (!context) throw new Error("useEditor must be used inside EditorProvider");
  return context;
}
