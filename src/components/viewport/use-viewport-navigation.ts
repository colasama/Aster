import { type Dispatch, type RefObject, useEffect, useState } from "react";
import type { EditorAction, EditorState } from "../../state/editor-store";
import { fitViewportZoom } from "../../ui/viewport-zoom";

export const VIEWPORT_ZOOM_COMMAND = "aster:viewport-zoom";

export function useViewportNavigation(
  spaceRef: RefObject<HTMLDivElement | null>,
  composition: { width: number; height: number },
  viewCount: number,
  state: Pick<EditorState, "viewportZoom" | "viewportZoomMode" | "viewportFitRevision">,
  dispatch: Dispatch<EditorAction>,
) {
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const space = spaceRef.current;
    if (!space) return;
    const measure = () =>
      setBounds((current) => {
        const width = space.clientWidth;
        const height = space.clientHeight;
        return width === current.width && height === current.height ? current : { width, height };
      });
    const observer = new ResizeObserver(measure);
    observer.observe(space);
    measure();
    return () => observer.disconnect();
  }, [spaceRef]);
  const zoom =
    state.viewportZoomMode === "manual"
      ? state.viewportZoom
      : fitViewportZoom(
          bounds.width,
          bounds.height,
          composition.width,
          composition.height,
          viewCount,
          state.viewportZoomMode === "fit100" ? 1 : undefined,
        );
  useEffect(() => {
    void state.viewportFitRevision;
    if (state.viewportZoomMode === "manual" || zoom <= 0) return;
    spaceRef.current?.scrollTo({ left: 0, top: 0 });
  }, [spaceRef, zoom, state.viewportZoomMode, state.viewportFitRevision]);
  useEffect(() => {
    const onZoom = (event: Event) => {
      if (event.defaultPrevented) return;
      const panel = spaceRef.current?.closest(".viewport-panel");
      const focused = document.activeElement?.closest(".viewport-panel");
      if (!panel || panel.closest("[hidden]") || (focused && focused !== panel)) return;
      event.preventDefault();
      dispatch({
        type: "setViewportZoom",
        zoom: zoom * ((event as CustomEvent<number>).detail > 0 ? 1.15 : 1 / 1.15),
      });
    };
    window.addEventListener(VIEWPORT_ZOOM_COMMAND, onZoom);
    return () => window.removeEventListener(VIEWPORT_ZOOM_COMMAND, onZoom);
  }, [dispatch, spaceRef, zoom]);
  return zoom;
}
