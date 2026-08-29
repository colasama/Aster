import { desktopRenderQueue, isDesktopRuntime } from "./api";

export function revealRenderOutput(path: string): Promise<void> {
  if (!isDesktopRuntime()) return Promise.reject(new Error("Aster Desktop is unavailable"));
  return desktopRenderQueue().reveal(path);
}
