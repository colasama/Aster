import { type RefObject, useEffect, useRef, useState } from "react";

export function copyViewportSnapshot(
  source: HTMLCanvasElement,
  target: HTMLCanvasElement,
): boolean {
  if (!source.width || !source.height) return false;
  // ponytail: one preview-sized comparison, capped at 16 MiB; add slots only when needed.
  const scale = Math.min(1, 2048 / Math.max(source.width, source.height));
  target.width = Math.max(1, Math.round(source.width * scale));
  target.height = Math.max(1, Math.round(source.height * scale));
  const context = target.getContext("2d");
  if (!context) return false;
  context.drawImage(source, 0, 0, target.width, target.height);
  return true;
}

export function useViewportSnapshot(
  source: RefObject<HTMLCanvasElement | null>,
  contextKey: string,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [capturedKey, setCapturedKey] = useState<string>();
  const [showing, setShowing] = useState(false);
  const captureVersion = useRef(0);
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const available = capturedKey === contextKey;
  useEffect(() => {
    setCapturedKey((key) => (key === contextKey ? key : undefined));
    setShowing(false);
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    return () => {
      captureVersion.current++;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [contextKey]);
  useEffect(() => {
    const release = () => setShowing(false);
    window.addEventListener("blur", release);
    return () => window.removeEventListener("blur", release);
  }, []);
  return {
    canvasRef,
    available,
    showing: available && showing,
    show: () => {
      if (available) setShowing(true);
    },
    hide: () => setShowing(false),
    capture: () => {
      captureVersion.current++;
      if (
        !source.current ||
        !canvasRef.current ||
        !copyViewportSnapshot(source.current, canvasRef.current)
      )
        return;
      setCapturedKey(contextKey);
      setShowing(false);
    },
    captureAsync: async (load: () => Promise<HTMLCanvasElement>) => {
      const version = ++captureVersion.current;
      const frame = await load();
      try {
        if (
          version !== captureVersion.current ||
          contextKey !== currentContext.current ||
          !canvasRef.current ||
          !copyViewportSnapshot(frame, canvasRef.current)
        )
          return;
        setCapturedKey(contextKey);
        setShowing(false);
      } finally {
        frame.width = 0;
        frame.height = 0;
      }
    },
  };
}
