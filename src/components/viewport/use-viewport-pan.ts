import { type PointerEvent, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { isEditableShortcutTarget } from "../../ui/keyboard-shortcuts";

export function useViewportPan(spaceRef: RefObject<HTMLDivElement | null>, handTool: boolean) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number } | undefined>(undefined);
  const stop = useCallback(() => {
    const space = spaceRef.current;
    const pointer = drag.current;
    drag.current = undefined;
    setPanning(false);
    if (pointer && space?.hasPointerCapture(pointer.id)) space.releasePointerCapture(pointer.id);
  }, [spaceRef]);
  useEffect(() => {
    window.addEventListener("blur", stop);
    return () => window.removeEventListener("blur", stop);
  }, [stop]);

  return {
    offset,
    setOffset,
    panning,
    handlers: {
      onPointerDownCapture(event: PointerEvent<HTMLDivElement>) {
        if (
          isEditableShortcutTarget(event.target) ||
          (event.button !== 1 && !(event.button === 0 && handTool))
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
        setPanning(true);
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        const pointer = drag.current;
        if (!pointer || pointer.id !== event.pointerId) return;
        const space = event.currentTarget;
        const scale = space.getBoundingClientRect().width / space.clientWidth || 1;
        const speed = (event.shiftKey ? 3 : 1) / scale;
        const dx = (event.clientX - pointer.x) * speed;
        const dy = (event.clientY - pointer.y) * speed;
        drag.current = { ...pointer, x: event.clientX, y: event.clientY };
        setOffset((current) => ({ x: current.x + dx, y: current.y + dy }));
      },
      onPointerUp: stop,
      onPointerCancel: stop,
      onLostPointerCapture: stop,
    },
  };
}
