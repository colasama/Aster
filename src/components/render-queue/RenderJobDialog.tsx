import { X } from "lucide-react";
import { useState } from "react";
import { activeComposition } from "../../core/project/project";
import { isDesktopRuntime } from "../../desktop/api";
import { reportUiError } from "../../errors/report-ui-error";
import { useI18n } from "../../i18n/react";
import { createRenderQueueJobAsync } from "../../render-queue/render-job-builder";
import {
  getRenderQueueUiStore,
  type RenderQueueUiStore,
} from "../../render-queue/render-queue-store";
import { useEditor } from "../../state/editor-store";
import { useDialogFocus } from "../use-dialog-focus";
import {
  chooseRenderDestination,
  RenderJobFields,
  renderJobRequest,
  useRenderJobOptions,
} from "./render-job-form";

export function RenderJobDialog({
  onClose,
  onQueued,
  queueStore = getRenderQueueUiStore(),
}: {
  readonly onClose: () => void;
  readonly onQueued?: () => void;
  readonly queueStore?: RenderQueueUiStore;
}) {
  const { state } = useEditor();
  const { t } = useI18n();
  const composition = activeComposition(state.project);
  const options = useRenderJobOptions(composition.duration);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useDialogFocus<HTMLDivElement>({
    onClose: () => {
      if (!submitting) onClose();
    },
  });
  const submit = async () => {
    setSubmitting(true);
    try {
      const destination = await chooseRenderDestination(options.outputKind, composition.name, t);
      if (!destination) return;
      await queueStore.enqueue(
        await createRenderQueueJobAsync({
          ...renderJobRequest(options, {
            composition,
            project: state.project,
            projectRevision: state.projectRevision,
            appAntiAliasing: state.antiAliasing,
            currentTime: state.currentTime,
          }),
          destination,
        }),
      );
      onQueued?.();
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
      setSubmitting(false);
    }
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        aria-label={t("topbar.render.title")}
        aria-modal="true"
        className="render-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <strong>{t("topbar.render.title")}</strong>
          <button
            aria-label={t("topbar.command.close")}
            disabled={submitting}
            onClick={onClose}
            type="button"
          >
            <X size={14} />
          </button>
        </header>
        {isDesktopRuntime() ? (
          <form
            aria-busy={submitting}
            className="render-queue-add render-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <RenderJobFields disabled={submitting} options={options} />
            <div className="render-queue-add-actions">
              <button disabled={submitting} onClick={onClose} type="button">
                {t("common.cancel")}
              </button>
              <button className="primary" disabled={submitting || !options.valid} type="submit">
                {t(submitting ? "renderQueue.adding" : "renderQueue.add")}
              </button>
            </div>
          </form>
        ) : (
          <p className="render-dialog-unavailable">{t("renderQueue.desktopRequired")}</p>
        )}
      </div>
    </div>
  );
}
