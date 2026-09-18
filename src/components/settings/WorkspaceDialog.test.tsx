// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as desktopApi from "../../desktop/api";
import { defaultAppPreferences } from "../../desktop/preferences";
import { diagnosticStore } from "../../errors/diagnostic-store";
import { I18nProvider } from "../../i18n/react";
import { createInitialState, EditorProvider, useEditor } from "../../state/editor-store";
import { WorkspaceDialog } from "./WorkspaceDialog";

let root: Root | undefined;
const shellStyles = ["shell-chrome", "dialogs", "shell-panels"]
  .map((name) => readFileSync(resolve(process.cwd(), `src/styles/${name}.css`), "utf8"))
  .join("\n");

function clearDiagnostics() {
  for (const diagnostic of diagnosticStore.snapshot()) diagnosticStore.resolve(diagnostic.id);
  diagnosticStore.clearInactive();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem("aster.locale", "en-US");
  clearDiagnostics();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
  clearDiagnostics();
  vi.restoreAllMocks();
});

describe("WorkspaceDialog diagnostics", () => {
  it("reports an HDR validation cause with composition and asset identity", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <WorkspaceDialog kind="composition" onClose={() => undefined} />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    const picker = container.querySelector<HTMLInputElement>(
      'input[accept=".hdr,image/vnd.radiance,image/x-hdr"]',
    );
    if (!picker) throw new Error("Expected HDR environment picker");
    Object.defineProperty(picker, "files", {
      configurable: true,
      value: [new File([], "empty.hdr", { type: "image/vnd.radiance" })],
    });
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(diagnosticStore.snapshot()).toHaveLength(1);
    expect(diagnosticStore.snapshot()[0]).toMatchObject({
      code: "ui_hdr_import_failed",
      message: "HDR environment must be between 1 byte and 48 MiB",
      scope: {
        area: "asset",
        assetName: "empty.hdr",
      },
      details: { message: "HDR environment must be between 1 byte and 48 MiB" },
    });
    expect(diagnosticStore.snapshot()[0]?.scope.compositionId).toBeTruthy();
  });
});

describe("WorkspaceDialog scaled layout", () => {
  it("restores authoritative desktop navigation and persists changes through IPC", async () => {
    window.localStorage.setItem("aster.viewportNavigationMode", "smooth");
    const preferences = { ...defaultAppPreferences(), viewportNavigationMode: "legacy" as const };
    vi.spyOn(desktopApi, "isDesktopRuntime").mockReturnValue(true);
    const migrate = vi.spyOn(desktopApi, "migrateLegacyPreferences").mockResolvedValue(preferences);
    vi.spyOn(desktopApi, "getPreferences").mockResolvedValue(preferences);
    const update = vi.spyOn(desktopApi, "updatePreferences").mockResolvedValue(preferences);
    function NavigationState() {
      return <output>{useEditor().state.viewportNavigationMode}</output>;
    }
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <WorkspaceDialog kind="preferences" onClose={() => undefined} />
            <NavigationState />
          </EditorProvider>
        </I18nProvider>,
      ),
    );
    expect(migrate).toHaveBeenCalledWith(
      expect.objectContaining({ viewportNavigationMode: "smooth" }),
    );
    expect(container.querySelector("output")?.textContent).toBe("legacy");
    expect(window.localStorage.getItem("aster.viewportNavigationMode")).toBe("legacy");
    const select = container
      .querySelector<HTMLOptionElement>('option[value="legacy"]')
      ?.closest("select");
    if (!select) throw new Error("Navigation select missing");
    expect(select.value).toBe("legacy");
    act(() => {
      select.value = "smooth";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>("footer button.primary")?.click(),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ viewportNavigationMode: "smooth" }),
    );
    expect(container.querySelector("output")?.textContent).toBe("smooth");
  });
  it.each([undefined, "smooth", "legacy", "invalid"])(
    "restores navigation preference %s and applies it only when saved",
    (savedMode) => {
      if (savedMode) window.localStorage.setItem("aster.viewportNavigationMode", savedMode);
      const initialMode = savedMode === "legacy" ? "legacy" : "smooth";
      const nextMode = initialMode === "legacy" ? "smooth" : "legacy";
      function NavigationState() {
        return <output>{useEditor().state.viewportNavigationMode}</output>;
      }
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      const close = vi.fn();
      act(() =>
        root?.render(
          <I18nProvider>
            <EditorProvider>
              <WorkspaceDialog kind="preferences" onClose={close} />
              <NavigationState />
            </EditorProvider>
          </I18nProvider>,
        ),
      );
      const select = container
        .querySelector<HTMLOptionElement>('option[value="legacy"]')
        ?.closest("select");
      if (!select) throw new Error("Navigation select missing");
      expect(select.value).toBe(initialMode);
      act(() => {
        select.value = nextMode;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(container.querySelector("output")?.textContent).toBe(initialMode);
      expect(window.localStorage.getItem("aster.viewportNavigationMode")).toBe(savedMode ?? null);
      act(() => container.querySelector<HTMLButtonElement>("footer button.primary")?.click());
      expect(container.querySelector("output")?.textContent).toBe(nextMode);
      expect(window.localStorage.getItem("aster.viewportNavigationMode")).toBe(nextMode);
      expect(createInitialState().viewportNavigationMode).toBe(nextMode);
      expect(close).toHaveBeenCalledOnce();
    },
  );
  it.each([undefined, "off", "ssaa2x"])(
    "restores AA preference %s with FXAA as the default and saves the selection",
    (savedMode) => {
      if (savedMode) window.localStorage.setItem("aster.antiAliasing", savedMode);
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      const close = vi.fn();
      act(() =>
        root?.render(
          <I18nProvider>
            <EditorProvider>
              <WorkspaceDialog kind="preferences" onClose={close} />
            </EditorProvider>
          </I18nProvider>,
        ),
      );
      const select = container
        .querySelector<HTMLOptionElement>('option[value="fxaa"]')
        ?.closest("select");
      if (!select) throw new Error("AA select missing");
      expect(select.value).toBe(savedMode ?? "fxaa");
      expect([...select.options].map((option) => option.value)).toEqual([
        "off",
        "fxaa",
        "ssaa2x",
        "ssaa4x",
      ]);
      act(() => {
        select.value = "fxaa";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      act(() => container.querySelector<HTMLButtonElement>("footer button.primary")?.click());
      expect(window.localStorage.getItem("aster.antiAliasing")).toBe("fxaa");
      expect(close).toHaveBeenCalledOnce();
    },
  );
  it.each([0.75, 1, 1.25, 1.5, 1.75, 2])(
    "restores the %s scale choice with reachable footer actions",
    (scale) => {
      window.localStorage.setItem("aster.uiScale", String(scale));
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      act(() =>
        root?.render(
          <I18nProvider>
            <EditorProvider>
              <WorkspaceDialog kind="preferences" onClose={() => undefined} />
            </EditorProvider>
          </I18nProvider>,
        ),
      );
      const scaleOption = container.querySelector<HTMLOptionElement>(`option[value="${scale}"]`);
      const scaleSelect = scaleOption?.closest("select");
      const dialog = container.querySelector<HTMLElement>(".workspace-dialog");
      const body = dialog?.querySelector<HTMLElement>(":scope > .preferences-form");
      const footer = dialog?.querySelector<HTMLElement>(":scope > footer");
      expect(scaleSelect?.value).toBe(String(scale));
      expect(body?.nextElementSibling).toBe(footer);
      expect(footer?.querySelector('button[type="button"].primary')).not.toBeNull();
    },
  );

  it("bounds the dialog and scrolls its body without moving header or footer actions", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <WorkspaceDialog kind="preferences" onClose={() => undefined} />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    const dialog = container.querySelector<HTMLElement>(".workspace-dialog");
    const body = dialog?.querySelector<HTMLElement>(":scope > .preferences-form");
    const header = dialog?.querySelector<HTMLElement>(":scope > header");
    const footer = dialog?.querySelector<HTMLElement>(":scope > footer");
    if (!dialog || !body || !header || !footer) throw new Error("Expected preferences dialog");

    expect(shellStyles).toMatch(
      /\.workspace-dialog\s*\{[^}]*display:\s*flex;[^}]*max-height:\s*72vh;[^}]*flex-direction:\s*column;/s,
    );
    expect(shellStyles).toMatch(
      /\.workspace-dialog > header,\s*\.workspace-dialog > footer\s*\{[^}]*flex:\s*0 0 auto;/s,
    );
    expect(shellStyles).toMatch(
      /\.workspace-dialog > :not\(header\):not\(footer\)\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s,
    );
    expect(shellStyles).toMatch(
      /\.modal-backdrop\s*\{[^}]*overflow:\s*auto;[^}]*padding:\s*14vh 16px;/s,
    );
    expect(shellStyles).toMatch(
      /\.app-menu-popover\s*\{[^}]*max-height:\s*calc\(100vh - 37px\);[^}]*overflow-y:\s*auto;/s,
    );
    expect(shellStyles).toMatch(
      /\.window-controls\s*\{[^}]*flex:\s*0 0 auto;[^}]*-webkit-app-region:\s*no-drag;/s,
    );
    expect(shellStyles).toMatch(/\.window-control\s*\{[^}]*width:\s*46px;[^}]*height:\s*100%;/s);
    expect([...dialog.children]).toEqual([header, body, footer]);
    expect(footer.querySelector('button[type="button"].primary')?.textContent).toContain(
      "Save preferences",
    );
  });
});
