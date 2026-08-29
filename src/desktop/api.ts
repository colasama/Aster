import type {
  AgentHostEvent,
  AgentRunRequest,
  AgentRunResult,
  AgentToolResponse,
  FullAccessActivationRequest,
  FullAccessGrant,
} from "../ai/agent-protocol";
import type { UiScale } from "../ui/ui-scale";
import type { AppPreferences, UserPreferencePatch } from "./preferences";

export interface DesktopFileFilter {
  name: string;
  extensions: string[];
}

export interface DesktopOpenOptions {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  filters?: DesktopFileFilter[];
}

export interface DesktopSaveOptions {
  title?: string;
  defaultPath?: string;
  filters?: DesktopFileFilter[];
}

export type Mp4PixelFormat = "bgra" | "rgba";

export interface Mp4ExportStartOptions {
  outputPath: string;
  width: number;
  height: number;
  frameRateNumerator: number;
  frameRateDenominator: number;
  frameCount: number;
  pixelFormat: Mp4PixelFormat;
}

export interface Mp4ExportStarted {
  jobId: string;
  encoder: "h264_nvenc" | "libx264";
}

export interface Mp4ExportReport extends Mp4ExportStarted {
  outputPath: string;
  frameCount: number;
  bytesWritten: number;
  elapsedMs: number;
}

export type DesktopPlatform = "darwin" | "linux" | "win32";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface DesktopLogEntry {
  level: LogLevel;
  scope: string;
  event: string;
  message?: string;
  data?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export interface DesktopWindowControls {
  platform: DesktopPlatform;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  close(): Promise<void>;
  onMaximizedChange(listener: (maximized: boolean) => void): () => void;
}

export interface DesktopDisplayMetrics {
  deviceScaleFactor: number;
  effectiveScaleFactor: number;
  uiScale: UiScale;
}

export interface ProjectOpenRequest {
  path?: string;
  recoverAutosave: boolean;
}

export type UnsavedChangesDecision = "save" | "discard" | "cancel";

export interface DesktopDocumentLifecycle {
  updateState(state: { dirty: boolean; projectName: string }): void;
  confirmReplace(state: { dirty: boolean; projectName: string }): Promise<UnsavedChangesDecision>;
  confirmClose(): Promise<void>;
  confirmRecovery(projectName: string): Promise<boolean>;
  onCloseRequested(listener: (action: "save" | "discard") => void): () => void;
}

export interface AsterDesktopApi {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  runAgent(request: AgentRunRequest): Promise<AgentRunResult>;
  respondAgentTool(response: AgentToolResponse): Promise<void>;
  cancelAgent(sessionId: string): Promise<void>;
  onAgentEvent(listener: (event: AgentHostEvent) => void): () => void;
  activateFullAccess(request: FullAccessActivationRequest): Promise<FullAccessGrant>;
  revokeFullAccess(grantId: string): Promise<void>;
  emergencyStopAgent(sessionId: string, grantId?: string): Promise<void>;
  open(options: DesktopOpenOptions): Promise<string | string[] | null>;
  save(options: DesktopSaveOptions): Promise<string | null>;
  convertFileSrc(path: string): string;
  getPreferences(): Promise<AppPreferences>;
  updatePreferences(preferences: UserPreferencePatch): Promise<AppPreferences>;
  migrateLegacyPreferences(preferences: UserPreferencePatch): Promise<AppPreferences>;
  onDisplayMetricsChanged(listener: (metrics: DesktopDisplayMetrics) => void): () => void;
  authorizeRecentProject(path: string): Promise<boolean>;
  rememberProject(path: string): Promise<AppPreferences>;
  forgetActiveProject(): Promise<void>;
  takeNextProjectOpen(): Promise<ProjectOpenRequest | undefined>;
  onProjectOpenAvailable(listener: () => void): () => void;
  documentLifecycle: DesktopDocumentLifecycle;
  exportDiagnostics(): Promise<string | undefined>;
  startMp4Export(options: Mp4ExportStartOptions): Promise<Mp4ExportStarted>;
  writeMp4Frame(jobId: string, pixels: ArrayBuffer): Promise<void>;
  finishMp4Export(jobId: string): Promise<Mp4ExportReport>;
  cancelMp4Export(jobId: string): Promise<void>;
  log(entry: DesktopLogEntry): void;
  windowControls: DesktopWindowControls;
}

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && window.asterDesktop !== undefined;
}

export function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return desktopApi().invoke<T>(command, args);
}

export function runAgent(request: AgentRunRequest): Promise<AgentRunResult> {
  return desktopApi().runAgent(request);
}

export function respondAgentTool(response: AgentToolResponse): Promise<void> {
  return desktopApi().respondAgentTool(response);
}

export function cancelAgent(sessionId: string): Promise<void> {
  return desktopApi().cancelAgent(sessionId);
}

export function onAgentEvent(listener: (event: AgentHostEvent) => void): () => void {
  return desktopApi().onAgentEvent(listener);
}

export function activateFullAccess(request: FullAccessActivationRequest): Promise<FullAccessGrant> {
  return desktopApi().activateFullAccess(request);
}

export function revokeFullAccess(grantId: string): Promise<void> {
  return desktopApi().revokeFullAccess(grantId);
}

export function emergencyStopAgent(sessionId: string, grantId?: string): Promise<void> {
  return desktopApi().emergencyStopAgent(sessionId, grantId);
}

export function open(options: DesktopOpenOptions): Promise<string | string[] | null> {
  return desktopApi().open(options);
}

export function save(options: DesktopSaveOptions): Promise<string | null> {
  return desktopApi().save(options);
}

export function convertFileSrc(path: string): string {
  return desktopApi().convertFileSrc(path);
}

export function getPreferences(): Promise<AppPreferences> {
  return desktopApi().getPreferences();
}

export function updatePreferences(preferences: UserPreferencePatch): Promise<AppPreferences> {
  return desktopApi().updatePreferences(preferences);
}

export function migrateLegacyPreferences(
  preferences: UserPreferencePatch,
): Promise<AppPreferences> {
  return desktopApi().migrateLegacyPreferences(preferences);
}

export function onDisplayMetricsChanged(
  listener: (metrics: DesktopDisplayMetrics) => void,
): () => void {
  return desktopApi().onDisplayMetricsChanged(listener);
}

export function authorizeRecentProject(path: string): Promise<boolean> {
  return desktopApi().authorizeRecentProject(path);
}

export function rememberProject(path: string): Promise<AppPreferences> {
  return desktopApi().rememberProject(path);
}

export function forgetActiveProject(): Promise<void> {
  return desktopApi().forgetActiveProject();
}

export function takeNextProjectOpen(): Promise<ProjectOpenRequest | undefined> {
  return desktopApi().takeNextProjectOpen();
}

export function onProjectOpenAvailable(listener: () => void): () => void {
  return desktopApi().onProjectOpenAvailable(listener);
}

export function documentLifecycle(): DesktopDocumentLifecycle {
  return desktopApi().documentLifecycle;
}

export function exportDiagnostics(): Promise<string | undefined> {
  return desktopApi().exportDiagnostics();
}

export function startMp4Export(options: Mp4ExportStartOptions): Promise<Mp4ExportStarted> {
  return desktopApi().startMp4Export(options);
}

export function writeMp4Frame(jobId: string, pixels: ArrayBuffer): Promise<void> {
  return desktopApi().writeMp4Frame(jobId, pixels);
}

export function finishMp4Export(jobId: string): Promise<Mp4ExportReport> {
  return desktopApi().finishMp4Export(jobId);
}

export function cancelMp4Export(jobId: string): Promise<void> {
  return desktopApi().cancelMp4Export(jobId);
}

function desktopApi(): AsterDesktopApi {
  if (!window.asterDesktop) throw new Error("Aster desktop API is unavailable");
  return window.asterDesktop;
}
