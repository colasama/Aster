import { describe, expect, it, vi } from "vitest";
import { DiagnosticStore, MAX_DIAGNOSTICS } from "./diagnostic-store";

describe("DiagnosticStore", () => {
  it("deduplicates active failures while preserving first-seen identity", () => {
    const store = new DiagnosticStore();
    const first = store.report(
      { code: "decode", title: "Decode failed", message: "Unsupported mode" },
      { now: new Date("2026-08-30T00:00:00.000Z") },
    );
    const second = store.report(
      {
        code: "decode",
        title: "Decode failed",
        message: "Unsupported mode",
        severity: "fatal",
      },
      { now: new Date("2026-08-30T00:00:01.000Z") },
    );
    expect(second.id).toBe(first.id);
    expect(second.correlationId).not.toBe(first.correlationId);
    expect(second).toMatchObject({ occurrences: 2, severity: "fatal", persistent: true });
    expect(store.snapshot()).toHaveLength(1);
  });

  it("runs declared handlers, resolves persistent errors, and blocks dismissing them", async () => {
    const store = new DiagnosticStore();
    const retry = vi.fn();
    const diagnostic = store.report(
      {
        code: "gpu",
        title: "GPU unavailable",
        severity: "fatal",
        actions: [{ id: "retry", kind: "retry", label: "Retry" }],
      },
      { actionHandlers: { retry } },
    );
    store.dismiss(diagnostic.id);
    expect(store.snapshot()[0]?.status).toBe("active");
    expect(await store.invokeAction(diagnostic.id, "missing")).toBe(false);
    expect(await store.invokeAction(diagnostic.id, "retry")).toBe(true);
    expect(retry).toHaveBeenCalledOnce();
    store.resolve(diagnostic.id);
    expect(store.snapshot()[0]?.status).toBe("resolved");
    expect(await store.invokeAction(diagnostic.id, "retry")).toBe(false);
  });

  it("notifies subscribers and exposes wraparound active-error navigation", () => {
    const store = new DiagnosticStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const info = store.report({ code: "one", title: "One", severity: "info" });
    const warning = store.report({ code: "two", title: "Two", severity: "warning" });
    const error = store.report({ code: "three", title: "Three", severity: "error" });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.adjacent(undefined, 1, "warning")?.id).toBe(warning.id);
    expect(store.adjacent(error.id, 1, "warning")?.id).toBe(warning.id);
    store.dismiss(warning.id);
    expect(store.adjacent(undefined, -1, "warning")?.id).toBe(error.id);
    store.resolve(info.id);
    store.clearInactive();
    expect(store.snapshot().map((diagnostic) => diagnostic.id)).toEqual([error.id]);
    unsubscribe();
  });

  it("bounds history by discarding inactive and then lowest-severity entries", () => {
    const store = new DiagnosticStore();
    const fatal = store.report({ code: "fatal", title: "Fatal", severity: "fatal" });
    const resolved = store.report({ code: "resolved", title: "Resolved" });
    store.resolve(resolved.id);
    for (let index = 0; index < MAX_DIAGNOSTICS; index += 1)
      store.report({ code: `warning-${index}`, title: `Warning ${index}`, severity: "warning" });
    expect(store.snapshot()).toHaveLength(MAX_DIAGNOSTICS);
    expect(store.snapshot().some((diagnostic) => diagnostic.id === resolved.id)).toBe(false);
    expect(store.snapshot().some((diagnostic) => diagnostic.id === fatal.id)).toBe(true);
  });
});
