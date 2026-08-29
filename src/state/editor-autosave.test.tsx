// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_PREFERENCES_CHANGED_EVENT } from "../desktop/preferences";
import { EditorProvider, useEditor } from "./editor-store";

let root: Root | undefined;
let editor: ReturnType<typeof useEditor> | undefined;

function Probe() {
  editor = useEditor();
  return <output>{editor.state.autosave.status}</output>;
}

function mountEditor() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <EditorProvider>
        <Probe />
      </EditorProvider>,
    ),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  window.asterDesktop = undefined;
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  editor = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("editor recovery autosave", () => {
  it("writes a recovery snapshot after the configured idle interval without marking clean", async () => {
    window.localStorage.setItem("aster.autosaveSeconds", "15");
    mountEditor();
    const layerId = editor?.state.project.compositions[0].layers[0].id;
    expect(layerId).toBeTypeOf("string");
    act(() =>
      editor?.dispatch({
        type: "operation",
        operations: [{ type: "renameLayer", layerId: layerId as string, name: "Autosaved edit" }],
      }),
    );

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });

    const keys = Array.from({ length: window.localStorage.length }, (_, index) =>
      window.localStorage.key(index),
    );
    const recoveryKey = keys.find((key) => key?.includes("recoveryProject"));
    expect(recoveryKey).toBeTypeOf("string");
    expect(window.localStorage.getItem(recoveryKey as string)).toContain("Autosaved edit");
    expect(editor?.state.autosave.status).toBe("saved");
    expect(editor?.state.savedProjectRevision).not.toBe(editor?.state.projectRevision);
  });

  it("does not create recovery snapshots when autosave is disabled", () => {
    window.localStorage.setItem("aster.autosaveSeconds", "0");
    mountEditor();
    const layerId = editor?.state.project.compositions[0].layers[0].id as string;
    act(() =>
      editor?.dispatch({
        type: "operation",
        operations: [{ type: "renameLayer", layerId, name: "Manual only" }],
      }),
    );
    act(() => vi.advanceTimersByTime(120_000));
    expect(
      Array.from({ length: window.localStorage.length }, (_, index) =>
        window.localStorage.key(index),
      ).some((key) => key?.includes("recoveryProject")),
    ).toBe(false);
  });

  it("reschedules a dirty project when the autosave preference changes", async () => {
    window.localStorage.setItem("aster.autosaveSeconds", "60");
    mountEditor();
    const layerId = editor?.state.project.compositions[0].layers[0].id as string;
    act(() =>
      editor?.dispatch({
        type: "operation",
        operations: [{ type: "renameLayer", layerId, name: "Rescheduled edit" }],
      }),
    );
    act(() => vi.advanceTimersByTime(10_000));
    window.localStorage.setItem("aster.autosaveSeconds", "15");
    act(() => window.dispatchEvent(new Event(APP_PREFERENCES_CHANGED_EVENT)));

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });

    expect(editor?.state.autosave.status).toBe("saved");
  });
});
