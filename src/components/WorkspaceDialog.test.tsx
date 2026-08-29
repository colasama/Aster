// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnosticStore } from "../errors/diagnostic-store";
import { I18nProvider } from "../i18n/react";
import { EditorProvider } from "../state/editor-store";
import { WorkspaceDialog } from "./WorkspaceDialog";

let root: Root | undefined;

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
