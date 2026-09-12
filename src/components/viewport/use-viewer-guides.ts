import { useEffect, useState } from "react";
import { parseViewerGuides, type ViewerGuide } from "../../ui/viewer-guides";

const GUIDES_CHANGED = "aster:viewer-guides-changed";

function read(key: string): ViewerGuide[] {
  try {
    return parseViewerGuides(localStorage.getItem(key));
  } catch {
    return [];
  }
}

export function useViewerGuides(contextKey: string) {
  const key = `aster.viewer-guides.${contextKey}`;
  const [stored, setStored] = useState(() => ({ key, guides: read(key) }));
  if (stored.key !== key) setStored({ key, guides: read(key) });
  const guides = stored.key === key ? stored.guides : [];
  useEffect(() => {
    const sync = (event: Event) => {
      if (
        (event instanceof StorageEvent && event.key === key) ||
        (event as CustomEvent).detail === key
      )
        setStored({ key, guides: read(key) });
    };
    window.addEventListener("storage", sync);
    window.addEventListener(GUIDES_CHANGED, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(GUIDES_CHANGED, sync);
    };
  }, [key]);
  return {
    guides,
    update(next: ViewerGuide[]) {
      const bounded = parseViewerGuides(JSON.stringify(next));
      setStored({ key, guides: bounded });
      try {
        localStorage.setItem(key, JSON.stringify(bounded));
        window.dispatchEvent(new CustomEvent(GUIDES_CHANGED, { detail: key }));
      } catch {
        /* Keep guides usable when local storage is unavailable. */
      }
    },
  };
}
