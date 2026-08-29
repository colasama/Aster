import { describe, expect, it } from "vitest";
import { createDiagnostic, diagnosticFingerprint, serializeError } from "./diagnostic";

describe("editor diagnostics", () => {
  it("creates bounded scoped diagnostics with safe actions and a correlation id", () => {
    let next = 0;
    const diagnostic = createDiagnostic(
      {
        code: `import_${"x".repeat(200)}`,
        title: "Import failed",
        severity: "warning",
        scope: { area: "asset", assetName: "shot.psd" },
        actions: [
          { id: "retry", kind: "retry", label: "Retry" },
          { id: "help", kind: "help", label: "Help", url: "https://example.com/help" },
          { id: "unsafe", kind: "help", label: "Unsafe", url: "file:///secret" },
        ],
        error: new Error("Decoder rejected the color mode"),
      },
      new Date("2026-08-30T00:00:00.000Z"),
      () => `id-${++next}`,
    );
    expect(diagnostic).toMatchObject({
      id: "id-1",
      correlationId: "id-2",
      severity: "warning",
      message: "Decoder rejected the color mode",
      scope: { area: "asset", assetName: "shot.psd" },
      occurrences: 1,
      persistent: false,
    });
    expect(diagnostic.code.length).toBeLessThanOrEqual(96);
    expect(diagnostic.actions.map((action) => action.id)).toEqual(["retry", "help"]);
  });

  it("serializes bounded cause chains and thrown non-errors", () => {
    const root = new Error("root");
    const middle = new Error("middle") as Error & { cause: unknown };
    middle.cause = root;
    const outer = new Error("outer") as Error & { cause: unknown };
    outer.cause = middle;
    expect(serializeError(outer)).toMatchObject({
      message: "outer",
      cause: { message: "middle", cause: { message: "root" } },
    });
    expect(serializeError({ reason: "bad payload" })).toMatchObject({
      name: "NonErrorThrown",
      message: '{"reason":"bad payload"}',
    });
  });

  it("fingerprints user-visible failure identity and scope, not timestamps or ids", () => {
    const first = createDiagnostic({ code: "render", title: "Render", scope: { area: "render" } });
    const second = createDiagnostic({ code: "render", title: "Render", scope: { area: "render" } });
    expect(diagnosticFingerprint(first)).toBe(diagnosticFingerprint(second));
    second.scope.renderJobId = "different";
    expect(diagnosticFingerprint(first)).not.toBe(diagnosticFingerprint(second));
  });
});
