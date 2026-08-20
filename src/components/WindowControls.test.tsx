// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AsterDesktopApi, DesktopWindowControls } from "../desktop/api";
import { WindowControls } from "./WindowControls";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  window.asterDesktop = undefined;
  document.body.replaceChildren();
});

describe("custom window controls", () => {
  it("stays hidden outside the desktop runtime", () => {
    act(() => root.render(<WindowControls />));
    expect(container.childElementCount).toBe(0);
  });

  it("forwards actions and reflects maximize state", async () => {
    let maximizeListener: ((maximized: boolean) => void) | undefined;
    const controls = {
      platform: "win32",
      minimize: vi.fn().mockResolvedValue(undefined),
      toggleMaximize: vi.fn().mockResolvedValue(true),
      isMaximized: vi.fn().mockResolvedValue(false),
      close: vi.fn().mockResolvedValue(undefined),
      onMaximizedChange: vi.fn((listener: (maximized: boolean) => void) => {
        maximizeListener = listener;
        return vi.fn();
      }),
    } satisfies DesktopWindowControls;
    window.asterDesktop = { windowControls: controls } as unknown as AsterDesktopApi;

    await act(async () => root.render(<WindowControls />));
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(3);
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Maximize window");

    await act(async () => {
      buttons[0]?.click();
      buttons[1]?.click();
      buttons[2]?.click();
    });
    expect(controls.minimize).toHaveBeenCalledOnce();
    expect(controls.toggleMaximize).toHaveBeenCalledOnce();
    expect(controls.close).toHaveBeenCalledOnce();
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Restore window");

    act(() => maximizeListener?.(false));
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Maximize window");
  });
});
