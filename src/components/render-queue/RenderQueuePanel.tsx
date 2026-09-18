import { FolderOpen, Pause, Play, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { activeComposition } from "../../core/project/project";
import type { RenderJobStatus, RenderQueueViewItem } from "../../core/rendering/render-queue";
import { isDesktopRuntime, open, save } from "../../desktop/api";
import { revealRenderOutput } from "../../desktop/render-output";
import { reportUiError } from "../../errors/report-ui-error";
import { useI18n } from "../../i18n/react";
import {
  appendRenderSequenceName,
  createRenderQueueJobAsync,
  type RenderQueueOutputKind,
  type RenderQueueRange,
} from "../../render-queue/render-job-builder";
import {
  getRenderQueueUiStore,
  type RenderQueueUiStore,
} from "../../render-queue/render-queue-store";
import { useEditor } from "../../state/editor-store";
import { Panel } from "../Panel";

const ACTIVE_STATUSES = new Set<RenderJobStatus>([
  "preparing",
  "rendering",
  "pauseRequested",
  "paused",
]);

export function RenderQueuePanel({
  queueStore = getRenderQueueUiStore(),
}: {
  readonly queueStore?: RenderQueueUiStore;
}) {
  const { t } = useI18n();
  const snapshot = useSyncExternalStore(
    queueStore.subscribe,
    queueStore.getSnapshot,
    queueStore.getSnapshot,
  );
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => {
    queueStore.start();
    return () => queueStore.stop();
  }, [queueStore]);
  const paused = snapshot.queue.items.filter((item) => item.status === "paused");
  return (
    <Panel
      actions={
        <>
          <button
            aria-label={t("renderQueue.add")}
            disabled={!isDesktopRuntime() || snapshot.loading}
            onClick={() => setAddOpen(true)}
            title={t("renderQueue.add")}
            type="button"
          >
            <Plus size={12} />
          </button>
          <button
            aria-label={t("renderQueue.start")}
            disabled={paused.length === 0}
            onClick={() => {
              for (const item of paused)
                void queueStore
                  .command({ type: "resume", jobId: item.manifest.id })
                  .catch((error: unknown) => {
                    queueStore.reportError(error);
                    reportUiError(t, "backgroundRender", error, {
                      scope: {
                        area: "render",
                        compositionId: item.manifest.compositionId,
                        renderJobId: item.manifest.id,
                      },
                    });
                  });
            }}
            title={t("renderQueue.start")}
            type="button"
          >
            <Play size={12} />
          </button>
        </>
      }
      className="render-queue-panel"
      title={t("renderQueue.panelTitle")}
    >
      {addOpen ? <AddRenderJob onClose={() => setAddOpen(false)} queueStore={queueStore} /> : null}
      {snapshot.error ? (
        <div className="render-queue-error" role="alert">
          <span>{snapshot.error}</span>
          <button
            aria-label={t("renderQueue.dismissError")}
            onClick={() => queueStore.clearError()}
            type="button"
          >
            <X size={12} />
          </button>
        </div>
      ) : null}
      {snapshot.loading ? (
        <div className="render-queue-empty">{t("renderQueue.loading")}</div>
      ) : snapshot.queue.items.length === 0 ? (
        <div className="render-queue-empty">
          {isDesktopRuntime() ? t("renderQueue.empty") : t("renderQueue.desktopRequired")}
        </div>
      ) : (
        <ol aria-label={t("renderQueue.jobs")} className="render-queue-list">
          {snapshot.queue.items.map((item) => (
            <RenderQueueRow
              item={item}
              key={item.manifest.id}
              pending={snapshot.pendingJobIds.has(item.manifest.id)}
              queueStore={queueStore}
            />
          ))}
        </ol>
      )}
    </Panel>
  );
}

function AddRenderJob({
  onClose,
  queueStore,
}: {
  readonly onClose: () => void;
  readonly queueStore: RenderQueueUiStore;
}) {
  const { state } = useEditor();
  const { t } = useI18n();
  const [outputKind, setOutputKind] = useState<RenderQueueOutputKind>("mp4");
  const [range, setRange] = useState<RenderQueueRange>("workArea");
  const [adding, setAdding] = useState(false);
  const composition = activeComposition(state.project);
  const add = async () => {
    setAdding(true);
    try {
      const destination = await chooseDestination(outputKind, composition.name, t);
      if (!destination) return;
      await queueStore.enqueue(
        await createRenderQueueJobAsync({
          composition,
          project: state.project,
          projectRevision: state.projectRevision,
          antiAliasing: state.antiAliasing,
          outputKind,
          destination,
          range: outputKind === "still" ? "currentFrame" : range,
          currentTime: state.currentTime,
        }),
      );
      onClose();
    } catch (error) {
      queueStore.reportError(error);
      reportUiError(t, "backgroundRender", error, {
        scope: {
          area: "render",
          projectId: state.project.id,
          compositionId: composition.id,
        },
      });
    } finally {
      setAdding(false);
    }
  };
  return (
    <form
      aria-label={t("renderQueue.addJob")}
      className="render-queue-add"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <label>
        <span>{t("renderQueue.format")}</span>
        <select
          disabled={adding}
          onChange={(event) => setOutputKind(event.target.value as RenderQueueOutputKind)}
          value={outputKind}
        >
          <option value="mp4">{t("renderQueue.format.mp4")}</option>
          <option value="pngSequence">{t("renderQueue.format.pngSequence")}</option>
          <option value="still">{t("renderQueue.format.still")}</option>
        </select>
      </label>
      <label>
        <span>{t("renderQueue.range")}</span>
        <select
          disabled={adding || outputKind === "still"}
          onChange={(event) => setRange(event.target.value as RenderQueueRange)}
          value={outputKind === "still" ? "currentFrame" : range}
        >
          <option value="workArea">{t("renderQueue.range.workArea")}</option>
          <option value="composition">{t("renderQueue.range.composition")}</option>
          <option value="currentFrame">{t("renderQueue.range.currentFrame")}</option>
        </select>
      </label>
      <div className="render-queue-add-actions">
        <button disabled={adding} onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button className="primary" disabled={adding} type="submit">
          {t("renderQueue.add")}
        </button>
      </div>
    </form>
  );
}

function RenderQueueRow({
  item,
  pending,
  queueStore,
}: {
  readonly item: RenderQueueViewItem;
  readonly pending: boolean;
  readonly queueStore: RenderQueueUiStore;
}) {
  const { t } = useI18n();
  const progress = item.progress.totalFrames
    ? item.progress.completedFrames / item.progress.totalFrames
    : 0;
  const canRemove = !ACTIVE_STATUSES.has(item.status);
  const command = (type: "pause" | "resume" | "cancel" | "retry" | "remove") => {
    void queueStore.command({ type, jobId: item.manifest.id }).catch((error: unknown) => {
      queueStore.reportError(error);
      reportUiError(t, "backgroundRender", error, {
        scope: {
          area: "render",
          compositionId: item.manifest.compositionId,
          renderJobId: item.manifest.id,
        },
      });
    });
  };
  return (
    <li className={`render-queue-item status-${item.status}`} data-job-row>
      <div className="render-queue-item-heading">
        <strong>{item.manifest.compositionName}</strong>
        <span className="render-queue-status">
          <i /> {t(`renderQueue.status.${item.status}`)}
        </span>
      </div>
      <progress aria-label={t("renderQueue.progressLabel")} max={1} value={progress} />
      <div className="render-queue-metrics">
        <span>
          {t("renderQueue.frames", {
            current: item.progress.completedFrames,
            total: item.progress.totalFrames,
          })}
        </span>
        <span>{t("renderQueue.elapsed", { value: formatDuration(item.progress.elapsedMs) })}</span>
        {item.progress.estimatedRemainingMs === undefined ? null : (
          <span>
            {t("renderQueue.remaining", {
              value: formatDuration(item.progress.estimatedRemainingMs),
            })}
          </span>
        )}
        {item.attempts > 1 ? (
          <span>{t("renderQueue.attempts", { count: item.attempts })}</span>
        ) : null}
      </div>
      <div className="render-queue-outputs">
        {item.manifest.outputs.map((output) => (
          <button
            className="render-queue-output"
            disabled={item.status !== "completed"}
            key={output.id}
            onClick={() =>
              void revealRenderOutput(output.destination).catch((error: unknown) => {
                queueStore.reportError(error);
                reportUiError(t, "backgroundRender", error, {
                  scope: {
                    area: "render",
                    compositionId: item.manifest.compositionId,
                    renderJobId: item.manifest.id,
                  },
                });
              })
            }
            title={output.destination}
            type="button"
          >
            <FolderOpen size={11} />
            <span>{pathName(output.destination)}</span>
          </button>
        ))}
      </div>
      {item.error ? (
        <div className="render-queue-job-error" role="alert" title={item.error.code}>
          {item.error.message}
          {item.error.correlationId ? <code>{item.error.correlationId}</code> : null}
        </div>
      ) : null}
      <div className="render-queue-actions">
        {item.status === "rendering" ? (
          <ActionButton
            disabled={pending}
            icon={<Pause size={11} />}
            label={t("renderQueue.pause")}
            onClick={() => command("pause")}
          />
        ) : item.status === "paused" ? (
          <ActionButton
            disabled={pending}
            icon={<Play size={11} />}
            label={t("renderQueue.resume")}
            onClick={() => command("resume")}
          />
        ) : null}
        {item.status === "failed" || item.status === "cancelled" ? (
          <ActionButton
            disabled={pending}
            icon={<RotateCcw size={11} />}
            label={t("renderQueue.retry")}
            onClick={() => command("retry")}
          />
        ) : null}
        {!canRemove ? (
          <ActionButton
            disabled={pending}
            icon={<X size={11} />}
            label={t("renderQueue.cancel")}
            onClick={() => command("cancel")}
          />
        ) : item.status === "queued" || item.status === "paused" ? (
          <ActionButton
            disabled={pending}
            icon={<X size={11} />}
            label={t("renderQueue.cancel")}
            onClick={() => command("cancel")}
          />
        ) : null}
        <ActionButton
          disabled={pending || !canRemove}
          icon={<Trash2 size={11} />}
          label={t("renderQueue.remove")}
          onClick={() => command("remove")}
        />
      </div>
    </li>
  );
}

function ActionButton({
  disabled,
  icon,
  label,
  onClick,
}: {
  readonly disabled: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button aria-label={label} disabled={disabled} onClick={onClick} title={label} type="button">
      {icon}
      <span>{label}</span>
    </button>
  );
}

async function chooseDestination(
  kind: RenderQueueOutputKind,
  compositionName: string,
  t: ReturnType<typeof useI18n>["t"],
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

function formatDuration(value: number): string {
  const totalSeconds = Math.max(0, Math.round(value / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function pathName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
