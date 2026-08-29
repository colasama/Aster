// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticStore } from "../errors/diagnostic-store";
import { DiagnosticErrorBoundary } from "./DiagnosticBoundary";

const copy = {
  title: "Editor failed",
  message: "Unexpected failure",
  retry: "Retry",
  details: "Details",
  copy: "Copy",
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

describe("DiagnosticErrorBoundary", () => {
  it("reports a persistent fatal diagnostic and retries the subtree", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new DiagnosticStore();
    let fail = true;
    const Child = () => {
      if (fail)
        throw Object.assign(new Error("GPU pipeline failed"), { cause: new Error("device lost") });
      return <span>Recovered</span>;
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <DiagnosticErrorBoundary copy={copy} store={store}>
          <Child />
        </DiagnosticErrorBoundary>,
      ),
    );

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("GPU pipeline failed");
    expect(store.snapshot()[0]).toMatchObject({
      code: "react_render_failed",
      severity: "fatal",
      persistent: true,
      details: { message: "GPU pipeline failed" },
    });

    fail = false;
    act(() => container?.querySelector<HTMLButtonElement>("button")?.click());
    expect(container.textContent).toContain("Recovered");
    expect(store.snapshot()[0]?.status).toBe("resolved");
  });
});
