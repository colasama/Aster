import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type VisibilityListener = (visible: boolean) => void;
export type ObserveTimelineRow = (element: HTMLElement, listener: VisibilityListener) => () => void;

/** One observer per timeline; shells preserve row positions for selection and native scrolling. */
export function useTimelineRowObserver(
  container: RefObject<HTMLDivElement | null>,
): ObserveTimelineRow | undefined {
  const listeners = useRef(new Map<HTMLElement, VisibilityListener>());
  const observer = useRef<IntersectionObserver | undefined>(undefined);
  const observe = useCallback<ObserveTimelineRow>((element, listener) => {
    listeners.current.set(element, listener);
    observer.current?.observe(element);
    return () => {
      listeners.current.delete(element);
      observer.current?.unobserve(element);
    };
  }, []);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const intersection = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          listeners.current.get(entry.target as HTMLElement)?.(entry.isIntersecting);
      },
      { root: container.current?.closest(".timeline-scroll"), rootMargin: "240px 0px" },
    );
    observer.current = intersection;
    for (const element of listeners.current.keys()) intersection.observe(element);
    return () => {
      intersection.disconnect();
      observer.current = undefined;
    };
  }, [container]);
  return typeof IntersectionObserver === "undefined" ? undefined : observe;
}

export function useTimelineRowWindow(index: number, observe?: ObserveTimelineRow) {
  const ref = useRef<HTMLDivElement>(null);
  const height = useRef(30);
  const intersecting = useRef(!observe || index < 20);
  const pinned = useRef(false);
  const releaseGesture = useRef<(() => void) | undefined>(undefined);
  const [visible, setVisible] = useState(intersecting.current);
  const refresh = useCallback(() => {
    setVisible(
      intersecting.current ||
        pinned.current ||
        Boolean(ref.current?.contains(document.activeElement)),
    );
  }, []);
  useEffect(() => {
    const element = ref.current;
    if (!element || !observe) return;
    return observe(element, (value) => {
      intersecting.current = value;
      refresh();
    });
  }, [observe, refresh]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !visible) return;
    const measure = () => {
      if (element.offsetHeight) height.current = element.offsetHeight;
    };
    measure();
    const resize = new ResizeObserver(([entry]) => {
      height.current = entry?.borderBoxSize[0]?.blockSize || element.offsetHeight || height.current;
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, [visible]);
  useEffect(() => () => releaseGesture.current?.(), []);
  const pinGesture = () => {
    releaseGesture.current?.();
    pinned.current = true;
    const release = () => {
      for (const type of ["pointerup", "pointercancel", "dragend", "drop", "blur"])
        window.removeEventListener(type, release);
      pinned.current = false;
      releaseGesture.current = undefined;
      refresh();
    };
    releaseGesture.current = release;
    for (const type of ["pointerup", "pointercancel", "dragend", "drop", "blur"])
      window.addEventListener(type, release);
  };
  return {
    ref,
    visible,
    height: height.current,
    pinGesture,
    onBlur: () => queueMicrotask(refresh),
  };
}
