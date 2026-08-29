// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../i18n/core";
import { DiagnosticStore } from "./diagnostic-store";
import { isExpectedCancellation, reportUiError } from "./report-ui-error";

afterEach(() => vi.restoreAllMocks());

describe("reportUiError", () => {
  it("reports the concrete cause with localized recovery actions and correlation", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new DiagnosticStore();
    const root = new Error("PSD ZIP channel is truncated");
    const failure = Object.assign(new Error("Could not decode layer pixels"), { cause: root });
    const diagnostic = reportUiError(createTranslator("en-US"), "assetImageImport", failure, {
      scope: { area: "asset", assetName: "poster.psd" },
      store,
    });

    expect(diagnostic).toMatchObject({
      code: "ui_asset_image_import_failed",
      title: "Could not import the image. Check the file and try again.",
      message: "Could not decode layer pixels",
      scope: { area: "asset", assetName: "poster.psd" },
      details: { cause: { message: "PSD ZIP channel is truncated" } },
    });
    expect(diagnostic?.correlationId).toBeTruthy();
    expect(diagnostic?.actions.map((action) => action.id)).toEqual(["details", "copy"]);
  });

  it("resolves a diagnostic after a successful retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new DiagnosticStore();
    const retry = vi.fn();
    const diagnostic = reportUiError(createTranslator("zh-CN"), "projectSave", new Error("disk"), {
      scope: { area: "project", projectId: "project-1" },
      retry,
      store,
    });

    expect(diagnostic?.actions[0]).toMatchObject({ id: "retry", label: "重试" });
    expect(await store.invokeAction(diagnostic?.id ?? "", "retry")).toBe(true);
    expect(retry).toHaveBeenCalledOnce();
    expect(store.snapshot()[0]?.status).toBe("resolved");
  });

  it("keeps expected cancellation silent", () => {
    const store = new DiagnosticStore();
    const cancellation = new DOMException("User cancelled", "AbortError");
    expect(isExpectedCancellation(cancellation)).toBe(true);
    expect(
      reportUiError(createTranslator("en-US"), "projectOpen", cancellation, { store }),
    ).toBeUndefined();
    expect(store.snapshot()).toHaveLength(0);
  });
});
