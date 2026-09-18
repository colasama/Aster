import {
  type Dispatch,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { EditorAction, EditorState } from "../../state/editor-store";
import { isEditableShortcutTarget } from "../../ui/keyboard-shortcuts";
import { fitViewportZoom, normalizeViewportZoom, viewportWheelZoom } from "../../ui/viewport-zoom";
import { useViewportPan } from "./use-viewport-pan";

export const VIEWPORT_ZOOM_COMMAND = "aster:viewport-zoom";

export function useViewportNavigation(
  spaceRef: RefObject<HTMLDivElement | null>,
  stageRef: RefObject<HTMLDivElement | null>,
  composition: { width: number; height: number },
  viewCount: number,
  state: Pick<
    EditorState,
    "viewportZoom" | "viewportZoomMode" | "viewportFitRevision" | "activeTool"
  >,
  dispatch: Dispatch<EditorAction>,
) {
  const pan = useViewportPan(spaceRef, state.activeTool === "hand");
  const { setOffset } = pan;
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | undefined>(
    undefined,
  );
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
  const requestedZoom = useRef(zoom);
  requestedZoom.current = zoom;
  const zoomAt = useCallback(
    (value: number, pointer?: { clientX: number; clientY: number }) => {
      const next = normalizeViewportZoom(value);
      if (next === requestedZoom.current) return;
      const space = spaceRef.current;
      const stage = stageRef.current;
      if (space && stage) {
        const bounds = space.getBoundingClientRect();
        const image = stage.getBoundingClientRect();
        const clientX = pointer?.clientX ?? bounds.left + bounds.width / 2;
        const clientY = pointer?.clientY ?? bounds.top + bounds.height / 2;
        if (image.width > 0 && image.height > 0)
          anchor.current = {
            x: (clientX - image.left) / image.width,
            y: (clientY - image.top) / image.height,
            clientX,
            clientY,
          };
      }
      requestedZoom.current = next;
      dispatch({ type: "setViewportZoom", zoom: next });
    },
    [dispatch, spaceRef, stageRef],
  );
  useLayoutEffect(() => {
    void zoom;
    const point = anchor.current;
    anchor.current = undefined;
    const space = spaceRef.current;
    const stage = stageRef.current;
    if (!point || !space || !stage) return;
    const image = stage.getBoundingClientRect();
    const scale = space.getBoundingClientRect().width / space.clientWidth || 1;
    const dx = (point.clientX - image.left - point.x * image.width) / scale;
    const dy = (point.clientY - image.top - point.y * image.height) / scale;
    setOffset((current) => ({ x: current.x + dx, y: current.y + dy }));
  }, [zoom, setOffset, spaceRef, stageRef]);
  useLayoutEffect(() => {
    void state.viewportFitRevision;
    if (state.viewportZoomMode === "manual" || zoom <= 0) return;
    setOffset((current) => (current.x === 0 && current.y === 0 ? current : { x: 0, y: 0 }));
  }, [setOffset, zoom, state.viewportZoomMode, state.viewportFitRevision]);
  useEffect(() => {
    const space = spaceRef.current;
    if (!space) return;
    const wheel = (event: WheelEvent) => {
      if (isEditableShortcutTarget(event.target) || event.defaultPrevented || !event.deltaY) return;
      event.preventDefault();
      zoomAt(
        viewportWheelZoom(requestedZoom.current, event, space.clientHeight),
        event.altKey ? undefined : event,
      );
    };
    // React's delegated wheel listener is passive, so it cannot suppress Chromium page zoom.
    space.addEventListener("wheel", wheel, { passive: false });
    return () => space.removeEventListener("wheel", wheel);
  }, [spaceRef, zoomAt]);
  useEffect(() => {
    const onZoom = (event: Event) => {
      if (event.defaultPrevented) return;
      const panel = spaceRef.current?.closest(".viewport-panel");
      const focused = document.activeElement?.closest(".viewport-panel");
      if (!panel || panel.closest("[hidden]") || (focused && focused !== panel)) return;
      event.preventDefault();
      zoomAt(requestedZoom.current * ((event as CustomEvent<number>).detail > 0 ? 1.15 : 1 / 1.15));
    };
    window.addEventListener(VIEWPORT_ZOOM_COMMAND, onZoom);
    return () => window.removeEventListener(VIEWPORT_ZOOM_COMMAND, onZoom);
  }, [spaceRef, zoomAt]);
  return { ...pan, zoom };
}
