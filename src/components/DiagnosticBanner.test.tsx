// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticStore } from "../errors/diagnostic-store";
import { I18nProvider } from "../i18n/react";
import { DiagnosticBanner } from "./DiagnosticBanner";

let container: HTMLDivElement;
let root: Root;
let store: DiagnosticStore;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  store = new DiagnosticStore();
  window.localStorage.setItem("aster.locale", "en-US");
  act(() =>
    root.render(
      <I18nProvider>
        <DiagnosticBanner store={store} />
      </I18nProvider>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("DiagnosticBanner", () => {
  it("prioritizes severity, navigates active diagnostics, and dismisses recoverable entries", () => {
    act(() => {
      store.report({ code: "warning", title: "Warning", severity: "warning" });
      store.report({ code: "error", title: "Error", severity: "error" });
    });
    expect(container.textContent).toContain("Error");
    expect(container.textContent).toContain("1/2");
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Next diagnostic"]')?.click(),
    );
    expect(container.textContent).toContain("Warning");
    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss diagnostic"]')
        ?.click(),
    );
    expect(container.textContent).not.toContain("Warning");
    expect(container.textContent).toContain("Error");
  });

  it("keeps persistent failures visible and invokes retry handlers", async () => {
    const retry = vi.fn();
    act(() => {
      store.report(
        {
          code: "fatal",
          title: "GPU unavailable",
          severity: "fatal",
          actions: [{ id: "retry", kind: "retry", label: "Retry" }],
        },
        { actionHandlers: { retry } },
      );
    });
    expect(container.querySelector('button[aria-label="Dismiss diagnostic"]')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".diagnostic-actions button")?.click();
    });
    expect(retry).toHaveBeenCalledOnce();
  });

  it("opens bounded details and closes them with Escape", () => {
    act(() => {
      store.report({
        code: "expression",
        title: "Expression failed",
        error: new Error("Unknown identifier at line 2"),
        actions: [{ id: "details", kind: "details", label: "Details" }],
      });
    });
    act(() => container.querySelector<HTMLButtonElement>(".diagnostic-actions button")?.click());
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      "Unknown identifier at line 2",
    );
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
