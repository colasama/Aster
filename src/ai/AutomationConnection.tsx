import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { useEditor } from "../state/editor-store";
import { AutomationApplicationService } from "./automation-service";

export function AutomationConnection() {
  const { state, dispatch } = useEditor();
  const live = useRef(state);
  live.current = state;
  useEffect(() => {
    const api = window.asterDesktop?.automation;
    if (!api) return;
    const service = new AutomationApplicationService({
      read: () => live.current,
      commit: (operations, summary, expectedRevision) => {
        if (live.current.projectRevision !== expectedRevision)
          throw new Error("Live project changed before commit");
        flushSync(() =>
          dispatch({ type: "operation", operations, metadata: { source: "ai", summary } }),
        );
      },
      markSaved: (projectId, revision) =>
        flushSync(() => dispatch({ type: "markSaved", projectId, revision })),
    });
    const unsubscribe = api.onRequest((request) => {
      void service
        .execute(request)
        .then(
          (result) => api.respond({ requestId: request.requestId, result }),
          (error: unknown) =>
            api.respond({
              requestId: request.requestId,
              error: error instanceof Error ? error.message : String(error),
            }),
        )
        .catch(() => undefined);
    });
    const cancel = api.onCancel((clientId) => service.cancel(clientId));
    return () => {
      unsubscribe();
      cancel();
      service.close();
    };
  }, [dispatch]);
  return null;
}
