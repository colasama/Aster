import {
  Check,
  ChevronRight,
  History,
  Loader2,
  Send,
  Settings2,
  ShieldAlert,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentAccessMode, AgentHostEvent, FullAccessGrant } from "../ai/agent-protocol";
import { AsterAgentApplicationService } from "../ai/application-service";
import { planLocalAiOperations } from "../ai/local-planner";
import { renderAgentPreview } from "../ai/render-preview";
import type { Operation } from "../core/operations";
import { activeComposition } from "../core/project";
import type { Composition } from "../core/types";
import {
  activateFullAccess,
  cancelAgent,
  emergencyStopAgent,
  isDesktopRuntime,
  onAgentEvent,
  respondAgentTool,
  revokeFullAccess,
  runAgent,
} from "../desktop/api";
import { reportUiError } from "../errors/report-ui-error";
import type { PlainMessageKey, Translate } from "../i18n/core";
import { translateUiMessage, type UiMessageDescriptor, uiError, uiMessage } from "../i18n/errors";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";

const suggestions = [
  { intent: "Make the title spring in", labelKey: "ai.suggestion.springTitle" },
  { intent: "Add a soft glow to the selection", labelKey: "ai.suggestion.softGlow" },
  { intent: "Stagger the selected layers by 0.08s", labelKey: "ai.suggestion.stagger" },
] as const satisfies readonly { intent: string; labelKey: PlainMessageKey }[];

export function AiPanel() {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState<{
    summary: string;
    operations: Operation[];
    included: boolean[];
    baseRevision: number;
    verification: "verified_by_primary_model" | "metrics_only" | "not_verified";
  }>();
  const [providerOpen, setProviderOpen] = useState(false);
  const [provider, setProvider] = useState({
    baseUrl: "https://88996api.cloud/v1",
    apiKey: "",
    model: "deepseek-v4-flash-0731",
    supportsImages: false,
  });
  const [loading, setLoading] = useState(false);
  const [accessMode, setAccessMode] = useState<AgentAccessMode>("agent");
  const [agentOutput, setAgentOutput] = useState("");
  const [activeTool, setActiveTool] = useState<string>();
  const [fullAccessConfirmation, setFullAccessConfirmation] = useState("");
  const [fullAccessGrant, setFullAccessGrant] = useState<FullAccessGrant>();
  const [error, setError] = useState<UiMessageDescriptor>();
  const sessionId = useRef(crypto.randomUUID());
  const agentService = useRef<AsterAgentApplicationService | undefined>(undefined);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    return onAgentEvent((event: AgentHostEvent) => {
      if (event.sessionId !== sessionId.current) return;
      if (event.type === "text_delta") setAgentOutput((value) => `${value}${event.delta}`);
      else if (event.type === "tool_started") setActiveTool(event.toolName);
      else if (event.type === "tool_finished") setActiveTool(undefined);
      else if (event.type === "tool_request") {
        const service = agentService.current;
        if (!service) {
          void respondAgentTool({
            requestId: event.requestId,
            error: "Aster agent application service is unavailable",
          });
          return;
        }
        void service
          .executeTool(event.toolName, event.arguments)
          .then((result) => respondAgentTool({ requestId: event.requestId, result }))
          .catch((toolError: unknown) =>
            respondAgentTool({
              requestId: event.requestId,
              error: toolError instanceof Error ? toolError.message : String(toolError),
            }),
          );
      }
    });
  }, []);
  useEffect(() => {
    if (!fullAccessGrant) return;
    let providerHost = "";
    try {
      providerHost = new URL(provider.baseUrl).host;
    } catch {
      // An invalid provider URL cannot retain a scoped Full Access grant.
    }
    const expiresIn = Date.parse(fullAccessGrant.expiresAt) - Date.now();
    const scopeChanged =
      fullAccessGrant.projectId !== state.project.id ||
      fullAccessGrant.model !== provider.model ||
      fullAccessGrant.providerHost !== providerHost;
    const revoke = () => {
      void revokeFullAccess(fullAccessGrant.id).catch(() => undefined);
      setFullAccessGrant(undefined);
      setAccessMode("agent");
    };
    if (scopeChanged || expiresIn <= 0) {
      revoke();
      return;
    }
    const expiryTimer = window.setTimeout(revoke, Math.min(expiresIn, 2_147_483_647));
    return () => window.clearTimeout(expiryTimer);
  }, [fullAccessGrant, provider.baseUrl, provider.model, state.project.id]);
  const createPreview = async (intent: string) => {
    cancelled.current = false;
    setError(undefined);
    setAgentOutput("");
    if (isDesktopRuntime() && intent.trim()) {
      if (accessMode === "full_access" && !fullAccessGrant) {
        setError(uiMessage("ai.fullAccessRequired"));
        return;
      }
      setLoading(true);
      const service = new AsterAgentApplicationService({
        project: state.project,
        projectRevision: state.projectRevision,
        selection: state.selection,
        currentTime: state.currentTime,
        accessMode,
        primaryModelSupportsImages: provider.supportsImages,
        renderPreview: renderAgentPreview,
      });
      agentService.current = service;
      try {
        const result = await runAgent({
          sessionId: sessionId.current,
          prompt: intent,
          projectId: state.project.id,
          projectName: state.project.name,
          projectRevision: state.projectRevision,
          accessMode,
          ...(fullAccessGrant ? { grantId: fullAccessGrant.id } : {}),
          provider: {
            apiKey: provider.apiKey || null,
            baseUrl: provider.baseUrl,
            model: provider.model,
            supportsImages: provider.supportsImages,
          },
        });
        const submitted = service.submittedWorkspace();
        if (!submitted || result.submittedWorkspaceId !== submitted.workspaceId)
          throw new Error("The agent did not submit a valid edit workspace");
        setAgentOutput(result.text);
        if (accessMode === "full_access") {
          if (state.projectRevision !== submitted.baseRevision)
            throw new Error("The live project changed while the agent was working");
          dispatch({
            type: "operation",
            operations: submitted.operations,
            metadata: { source: "ai", summary: submitted.summary },
          });
          agentService.current = undefined;
          setPrompt("");
          return;
        }
        setPreview({
          summary: submitted.summary,
          operations: submitted.operations,
          included: submitted.operations.map(() => true),
          baseRevision: submitted.baseRevision,
          verification: submitted.verification,
        });
        setPrompt("");
        return;
      } catch (error) {
        service.abort();
        if (cancelled.current) return;
        setError(uiError("aiRequest"));
        reportUiError(t, "aiRequest", error, {
          scope: {
            area: "composition",
            projectId: state.project.id,
            compositionId: composition.id,
          },
        });
      } finally {
        setLoading(false);
      }
    }
    const local = planLocalAiOperations(intent, composition, state.selection, state.currentTime);
    if (local.operations.length === 0) {
      setError(uiMessage("ai.localSelectionError"));
      return;
    }
    setPreview({
      summary: local.summary,
      operations: local.operations,
      included: local.operations.map(() => true),
      baseRevision: state.projectRevision,
      verification: "not_verified",
    });
    setPrompt("");
  };
  const commitPreview = (operations: Operation[], summary: string, baseRevision: number) => {
    if (state.projectRevision !== baseRevision) {
      setPreview(undefined);
      setError(uiError("aiRequest"));
      return;
    }
    dispatch({ type: "operation", operations, metadata: { source: "ai", summary } });
    agentService.current = undefined;
    setPreview(undefined);
  };
  const composition = activeComposition(state.project);
  return (
    <div className="ai-panel">
      <div className="ai-intro">
        <span>
          <WandSparkles size={18} />
        </span>
        <div>
          <strong>{t("ai.title")}</strong>
          <small>{t("ai.subtitle")}</small>
        </div>
      </div>
      <div className="ai-context">
        <Sparkles size={12} />{" "}
        {t("ai.context", { composition: composition.name, count: state.selection.length })}
        <button
          onClick={() => setProviderOpen(!providerOpen)}
          title={t("ai.providerSettings")}
          type="button"
        >
          <Settings2 size={11} />
        </button>
      </div>
      {providerOpen && (
        <div className="provider-settings">
          <label>
            {t("ai.endpoint")}
            <input
              onChange={(event) => setProvider({ ...provider, baseUrl: event.target.value })}
              value={provider.baseUrl}
            />
          </label>
          <label>
            {t("ai.model")}
            <input
              onChange={(event) => setProvider({ ...provider, model: event.target.value })}
              value={provider.model}
            />
          </label>
          <label>
            {t("ai.apiKey")} <small>{t("ai.memoryOnly")}</small>
            <input
              autoComplete="off"
              onChange={(event) => setProvider({ ...provider, apiKey: event.target.value })}
              placeholder={t("ai.apiKeyPlaceholder")}
              type="password"
              value={provider.apiKey}
            />
          </label>
          <label className="provider-capability">
            <input
              checked={provider.supportsImages}
              onChange={(event) =>
                setProvider({ ...provider, supportsImages: event.target.checked })
              }
              type="checkbox"
            />
            {t("ai.supportsImages")}
          </label>
          <label>
            {t("ai.accessMode")}
            <select
              onChange={(event) => setAccessMode(event.target.value as AgentAccessMode)}
              value={accessMode}
            >
              <option value="review">{t("ai.access.review")}</option>
              <option value="agent">{t("ai.access.agent")}</option>
              <option value="full_access">{t("ai.access.full")}</option>
            </select>
          </label>
          {accessMode === "full_access" && !fullAccessGrant && (
            <div className="full-access-activation">
              <small>{t("ai.fullAccessHint", { project: state.project.name })}</small>
              <input
                autoComplete="off"
                onChange={(event) => setFullAccessConfirmation(event.target.value)}
                placeholder={state.project.name}
                value={fullAccessConfirmation}
              />
              <button
                disabled={
                  fullAccessConfirmation !== state.project.name &&
                  fullAccessConfirmation !== "FULL ACCESS"
                }
                onClick={() => {
                  void activateFullAccess({
                    projectId: state.project.id,
                    projectName: state.project.name,
                    model: provider.model,
                    providerBaseUrl: provider.baseUrl,
                    confirmation: fullAccessConfirmation,
                  })
                    .then((grant) => {
                      setFullAccessGrant(grant);
                      setFullAccessConfirmation("");
                    })
                    .catch((error: unknown) => {
                      setError(uiMessage("ai.fullAccessRequired"));
                      reportUiError(t, "aiRequest", error, {
                        scope: { area: "project", projectId: state.project.id },
                      });
                    });
                }}
                type="button"
              >
                {t("ai.activateFullAccess")}
              </button>
            </div>
          )}
        </div>
      )}
      {fullAccessGrant && (
        <div className="full-access-indicator">
          <ShieldAlert size={13} />
          <span>{t("ai.fullAccessActive")}</span>
          <button
            onClick={() => {
              void emergencyStopAgent(sessionId.current, fullAccessGrant.id);
              agentService.current?.abort();
              setFullAccessGrant(undefined);
              setAccessMode("agent");
              setLoading(false);
            }}
            type="button"
          >
            {t("ai.emergencyStop")}
          </button>
        </div>
      )}
      {error && (
        <div className="ai-error">
          {translateUiMessage(t, error)} · {t("ai.errorFallback")}
        </div>
      )}
      {(activeTool || agentOutput) && !preview && (
        <div className="ai-agent-status">
          {activeTool && <small>{t("ai.agentRunning", { tool: activeTool })}</small>}
          {agentOutput && <p>{agentOutput}</p>}
        </div>
      )}
      {!preview ? (
        <>
          <div className="ai-suggestions">
            <small>{t("ai.tryOperation")}</small>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.intent}
                onClick={() => void createPreview(suggestion.intent)}
                type="button"
              >
                <span>{t(suggestion.labelKey)}</span>
                <ChevronRight size={13} />
              </button>
            ))}
          </div>
          <div className="ai-empty">
            <History size={20} />
            {state.auditLog.length > 0 ? (
              <div className="ai-audit-log">
                <strong>{t("ai.recentPlans")}</strong>
                {state.auditLog
                  .slice(-3)
                  .reverse()
                  .map((entry) => (
                    <span key={entry.id}>
                      {entry.summary} ·{" "}
                      {t("ai.operationCount", { count: entry.operationTypes.length })}
                    </span>
                  ))}
              </div>
            ) : (
              <span>{t("ai.auditEmpty")}</span>
            )}
          </div>
        </>
      ) : (
        <div className="operation-preview">
          <div className="preview-heading">
            <Sparkles size={14} />
            <strong>{t("ai.preview")}</strong>
          </div>
          <p>{preview.summary}</p>
          <small>{verificationText(t, preview.verification)}</small>
          <div className="operation-list">
            {preview.operations.map((operation, index) => (
              <div
                className={preview.included[index] ? "" : "excluded"}
                key={JSON.stringify(operation)}
              >
                <input
                  aria-label={t("ai.includeOperation", { number: index + 1 })}
                  checked={preview.included[index]}
                  onChange={() =>
                    setPreview({
                      ...preview,
                      included: preview.included.map((included, candidate) =>
                        candidate === index ? !included : included,
                      ),
                    })
                  }
                  type="checkbox"
                />
                <span>{index + 1}</span>
                <div className="operation-diff">
                  <code>{operation.type}</code>
                  <small>{describeOperation(operation, composition, t)}</small>
                </div>
                {preview.included[index] && <Check size={12} />}
              </div>
            ))}
          </div>
          <div className="preview-actions">
            <button
              onClick={() => {
                cancelled.current = true;
                agentService.current?.abort();
                agentService.current = undefined;
                setPreview(undefined);
              }}
              type="button"
            >
              <X size={13} /> {t("ai.reject")}
            </button>
            <button
              disabled={!preview.included.some(Boolean)}
              onClick={() => {
                const selected = preview.operations.filter((_, index) => preview.included[index]);
                commitPreview(selected, preview.summary, preview.baseRevision);
              }}
              type="button"
            >
              <Check size={13} /> {t("ai.acceptSelected")}
            </button>
            <button
              className="accept"
              onClick={() =>
                commitPreview(preview.operations, preview.summary, preview.baseRevision)
              }
              type="button"
            >
              <Check size={13} /> {t("ai.acceptAll")}
            </button>
          </div>
        </div>
      )}
      <form
        className="ai-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void createPreview(prompt);
        }}
      >
        <textarea
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t("ai.prompt")}
          rows={3}
          value={prompt}
        />
        <div>
          <span>{t("ai.boundary")}</span>
          {loading ? (
            <button
              aria-label={t("ai.cancel")}
              onClick={() => {
                cancelled.current = true;
                agentService.current?.abort();
                void cancelAgent(sessionId.current);
              }}
              type="button"
            >
              <Loader2 className="spin" size={14} />
            </button>
          ) : (
            <button disabled={!prompt.trim()} type="submit">
              <Send size={14} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function describeOperation(operation: Operation, composition: Composition, t: Translate): string {
  const layer =
    "layerId" in operation
      ? composition.layers.find((candidate) => candidate.id === operation.layerId)
      : undefined;
  const target =
    layer?.name ?? ("layer" in operation ? operation.layer.name : t("ai.targetComposition"));
  switch (operation.type) {
    case "addLayer":
      return t("ai.operation.addLayer", {
        kind: operation.layer.kind,
        name: operation.layer.name,
      });
    case "removeLayer":
      return t("ai.operation.remove", { target });
    case "renameLayer":
      return `${target} → “${operation.name}”`;
    case "reorderLayer":
      return t("ai.operation.stackIndex", { target, index: operation.index });
    case "setProperty":
      return t("ai.operation.property", { target, path: operation.path, value: operation.value });
    case "addKeyframe":
      return t("ai.operation.keyframe", {
        target,
        path: operation.path,
        time: operation.keyframe.time.toFixed(2),
        value: operation.keyframe.value,
      });
    case "addEffect":
      return t("ai.operation.addEffect", { target, effect: operation.effect.name });
    case "removeEffect":
      return t("ai.operation.removeEffect", { target, id: operation.effectId.slice(0, 8) });
    case "setEffectParameter":
      return t("ai.operation.property", {
        target,
        path: operation.parameter,
        value: String(operation.value),
      });
    case "toggleLayer":
      return t("ai.operation.toggle", { target, field: operation.field });
    case "setTextAnimator":
      return t("ai.operation.toggle", { target, field: "textAnimator" });
    case "easeLayer":
      return t("ai.operation.ease", { target });
    case "setLayerTiming":
      return t("ai.operation.timing", {
        target,
        start: operation.inPoint.toFixed(2),
        end: operation.outPoint.toFixed(2),
      });
    default:
      return t("ai.operation.structured", { target });
  }
}

function verificationText(
  t: Translate,
  verification: "verified_by_primary_model" | "metrics_only" | "not_verified",
): string {
  switch (verification) {
    case "verified_by_primary_model":
      return t("ai.verification.verified_by_primary_model");
    case "metrics_only":
      return t("ai.verification.metrics_only");
    case "not_verified":
      return t("ai.verification.not_verified");
  }
}
