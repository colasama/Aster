export type AgentAccessMode = "review" | "agent" | "full_access";
export type VisualVerification = "verified_by_primary_model" | "metrics_only" | "not_verified";

export interface AgentProviderConfig {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  supportsImages: boolean;
}

export interface AgentRunRequest {
  sessionId?: string;
  prompt: string;
  projectId: string;
  projectName: string;
  projectRevision: number;
  accessMode: AgentAccessMode;
  grantId?: string;
  provider: AgentProviderConfig;
}

export interface FullAccessActivationRequest {
  projectId: string;
  projectName: string;
  model: string;
  providerBaseUrl: string;
  confirmation: string;
}

export interface FullAccessGrant {
  id: string;
  projectId: string;
  model: string;
  providerHost: string;
  expiresAt: string;
}

export interface AgentRunResult {
  sessionId: string;
  text: string;
  submittedWorkspaceId?: string;
}

export interface AgentToolRequestEvent {
  type: "tool_request";
  requestId: string;
  sessionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export type AgentHostEvent =
  | AgentToolRequestEvent
  | { type: "text_delta"; sessionId: string; delta: string }
  | { type: "tool_started"; sessionId: string; toolName: string }
  | { type: "tool_finished"; sessionId: string; toolName: string; isError: boolean };

export interface AgentToolResponse {
  requestId: string;
  result?: unknown;
  error?: string;
}

export interface VisualObservation {
  mode: "native_vision" | "deterministic_metrics" | "human_required";
  verification: VisualVerification;
  frames: Array<{ time: number; renderId: string }>;
  findings: Array<{ severity: "info" | "warning" | "error"; message: string }>;
  measurements: Record<string, unknown>;
  limitations: string[];
  confidence?: number;
}
