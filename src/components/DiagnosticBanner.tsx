import { AlertCircle, ChevronLeft, ChevronRight, Copy, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { DiagnosticAction, EditorDiagnostic, ErrorDetails } from "../errors/diagnostic";
import { severityRank } from "../errors/diagnostic";
import { type DiagnosticStore, diagnosticStore } from "../errors/diagnostic-store";
import { useI18n } from "../i18n/react";
import { useDialogFocus } from "./use-dialog-focus";

export function DiagnosticBanner({ store = diagnosticStore }: { store?: DiagnosticStore }) {
  const { t } = useI18n();
  const diagnostics = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const active = useMemo(
    () =>
      diagnostics
        .filter((diagnostic) => diagnostic.status === "active")
        .sort(
          (left, right) =>
            severityRank(right.severity) - severityRank(left.severity) ||
            right.lastSeenAt.localeCompare(left.lastSeenAt),
        ),
    [diagnostics],
  );
  const [selectedId, setSelectedId] = useState<string>();
  const [detailsId, setDetailsId] = useState<string>();
  const [pendingAction, setPendingAction] = useState<string>();
  const selected = active.find((diagnostic) => diagnostic.id === selectedId) ?? active[0];
  const selectedIndex = selected ? active.indexOf(selected) : -1;
  useEffect(() => {
    if (!selected && selectedId) setSelectedId(undefined);
    else if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);
  useEffect(() => {
    if (detailsId && !diagnostics.some((diagnostic) => diagnostic.id === detailsId))
      setDetailsId(undefined);
  }, [detailsId, diagnostics]);
  if (!selected) return null;

  const navigate = (direction: 1 | -1) => {
    const next = active[(selectedIndex + direction + active.length) % active.length];
    if (next) setSelectedId(next.id);
  };
  const runAction = async (action: DiagnosticAction) => {
    const pendingKey = `${selected.id}:${action.id}`;
    if (pendingAction) return;
    if (action.kind === "details") {
      setDetailsId(selected.id);
      return;
    }
    setPendingAction(pendingKey);
    try {
      if (action.kind === "help") window.open(action.url, "_blank", "noopener,noreferrer");
      else if (action.kind === "copy") await copyDiagnostic(selected);
      else await store.invokeAction(selected.id, action.id);
    } catch (error) {
      store.report({
        code: "diagnostic_action_failed",
        title: t("diagnostic.actionFailed"),
        severity: "error",
        scope: selected.scope,
        error,
      });
    } finally {
      setPendingAction(undefined);
    }
  };
  const details = detailsId
    ? diagnostics.find((diagnostic) => diagnostic.id === detailsId)
    : undefined;
  return (
    <>
      <section
        aria-atomic="true"
        aria-live={selected.severity === "info" ? "polite" : "assertive"}
        className={`diagnostic-banner ${selected.severity}`}
        data-diagnostic-id={selected.id}
      >
        <span className="diagnostic-severity-icon">
          {selected.severity === "info" ? (
            <Info aria-hidden="true" size={16} />
          ) : selected.severity === "warning" ? (
            <TriangleAlert aria-hidden="true" size={16} />
          ) : (
            <AlertCircle aria-hidden="true" size={16} />
          )}
        </span>
        <div className="diagnostic-summary">
          <strong>{selected.title}</strong>
          <span>{selected.message}</span>
          <small>
            {formatScope(selected)} · {selected.correlationId}
            {selected.occurrences > 1
              ? ` · ${t("diagnostic.occurrences", { count: selected.occurrences })}`
              : ""}
          </small>
        </div>
        <div className="diagnostic-actions">
          {selected.actions.map((action) => (
            <button
              disabled={Boolean(pendingAction)}
              key={action.id}
              onClick={() => void runAction(action)}
              type="button"
            >
              {action.kind === "copy" && <Copy aria-hidden="true" size={12} />}
              {action.label}
            </button>
          ))}
        </div>
        {active.length > 1 && (
          <div className="diagnostic-navigation">
            <button
              aria-label={t("diagnostic.previous")}
              onClick={() => navigate(-1)}
              type="button"
            >
              <ChevronLeft aria-hidden="true" size={14} />
            </button>
            <span>
              {selectedIndex + 1}/{active.length}
            </span>
            <button aria-label={t("diagnostic.next")} onClick={() => navigate(1)} type="button">
              <ChevronRight aria-hidden="true" size={14} />
            </button>
          </div>
        )}
        {!selected.persistent && (
          <button
            aria-label={t("diagnostic.dismiss")}
            className="diagnostic-dismiss"
            onClick={() => store.dismiss(selected.id)}
            type="button"
          >
            <X aria-hidden="true" size={14} />
          </button>
        )}
      </section>
      {details && (
        <DiagnosticDetails diagnostic={details} onClose={() => setDetailsId(undefined)} />
      )}
    </>
  );
}

function DiagnosticDetails({
  diagnostic,
  onClose,
}: {
  diagnostic: EditorDiagnostic;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useDialogFocus<HTMLElement>({ onClose });
  return (
    <div
      className="modal-backdrop diagnostic-details-backdrop"
      onPointerDown={onClose}
      role="presentation"
    >
      <section
        aria-label={t("diagnostic.details")}
        aria-modal="true"
        className="diagnostic-details"
        onPointerDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <strong>{diagnostic.title}</strong>
          <button aria-label={t("diagnostic.closeDetails")} onClick={onClose} type="button">
            <X aria-hidden="true" size={14} />
          </button>
        </header>
        <dl>
          <div>
            <dt>{t("diagnostic.code")}</dt>
            <dd>{diagnostic.code}</dd>
          </div>
          <div>
            <dt>{t("diagnostic.correlation")}</dt>
            <dd>{diagnostic.correlationId}</dd>
          </div>
          <div>
            <dt>{t("diagnostic.scope")}</dt>
            <dd>{formatScope(diagnostic)}</dd>
          </div>
        </dl>
        {diagnostic.details && <ErrorDetailTree details={diagnostic.details} />}
      </section>
    </div>
  );
}

function ErrorDetailTree({ details }: { details: ErrorDetails }) {
  return (
    <div className="diagnostic-error-detail">
      <strong>{details.name}</strong>
      <p>{details.message}</p>
      {details.stack && <pre>{details.stack}</pre>}
      {details.cause && (
        <div className="diagnostic-cause">
          <ErrorDetailTree details={details.cause} />
        </div>
      )}
    </div>
  );
}

function formatScope(diagnostic: EditorDiagnostic): string {
  const scope = diagnostic.scope;
  return [
    scope.area,
    scope.projectId,
    scope.compositionId,
    scope.layerId,
    scope.propertyPath,
    scope.assetName,
    scope.renderJobId,
  ]
    .filter(Boolean)
    .join(" / ");
}

async function copyDiagnostic(diagnostic: EditorDiagnostic): Promise<void> {
  const details = {
    code: diagnostic.code,
    correlationId: diagnostic.correlationId,
    severity: diagnostic.severity,
    scope: diagnostic.scope,
    message: diagnostic.message,
    occurrences: diagnostic.occurrences,
    firstSeenAt: diagnostic.firstSeenAt,
    lastSeenAt: diagnostic.lastSeenAt,
    details: diagnostic.details,
  };
  await navigator.clipboard.writeText(JSON.stringify(details, null, 2));
}
