export function applyReducedMotionPreference(
  root: HTMLElement = document.documentElement,
  storage: Pick<Storage, "getItem"> = window.localStorage,
): void {
  let reduced = false;
  try {
    reduced = storage.getItem("aster.reducedMotion") === "true";
  } catch {
    // The system media query remains the fallback when storage is unavailable.
  }
  root.classList.toggle("reduced-motion", reduced);
}
