// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeRenderPaused,
  cancelRenderJob,
  claimRenderJob,
  completeRenderJob,
  createRenderQueue,
  enqueueRenderJob,
  failRenderJob,
  markRenderJobRunning,
  type RenderQueueState,
  requestRenderPause,
} from "../../core/rendering/render-queue";
import type { AsterDesktopApi } from "../../desktop/api";
import { defaultAppPreferences } from "../../desktop/preferences";
import { I18nProvider } from "../../i18n/react";
import { type RenderQueueClient, RenderQueueUiStore } from "../../render-queue/render-queue-store";
import { EditorProvider } from "../../state/editor-store";
import { RenderQueuePanel } from "./RenderQueuePanel";

let container: HTMLDivElement;
let root: Root;

const input = (id: string) => ({
  id,
  compositionId: "composition",
  compositionName: `Composition ${id}`,
  projectRevision: 3,
  projectSnapshot: '{"schemaVersion":5}',
  width: 1920,
  height: 1080,
  frameRate: { numerator: 30, denominator: 1 },
  startFrame: 0,
  endFrameExclusive: 30,
  outputs: [
    {
      id: `${id}-output`,
      kind: "mp4" as const,
      destination: `C:\\renders\\${id}.mp4`,
      codec: "h264" as const,
      bitrateMbps: 20,
      includeAudio: false,
    },
  ],
});

function queue(): RenderQueueState {
  let state = enqueueRenderJob(createRenderQueue(), input("active"));
  state = claimRenderJob(state, "active", "active-lease");
  state = markRenderJobRunning(state, "active", "active-lease");
  state = enqueueRenderJob(state, input("failed"));
  state = claimRenderJob(state, "failed", "failed-lease");
  state = markRenderJobRunning(state, "failed", "failed-lease");
  state = failRenderJob(state, "failed", "failed-lease", {
    code: "encoder_failed",
    message: "Encoder stopped",
    correlationId: "correlation-1",
  });
  state = enqueueRenderJob(state, input("completed"));
  state = claimRenderJob(state, "completed", "completed-lease");
  state = markRenderJobRunning(state, "completed", "completed-lease");
  return completeRenderJob(state, "completed", "completed-lease");
}

function harness(state = queue()) {
  const frames: Array<() => void> = [];
  const client: RenderQueueClient = {
    snapshot: vi.fn(async () => state),
    enqueue: vi.fn(async () => state),
    command: vi.fn(async () => state),
    onChanged: vi.fn(() => () => undefined),
  };
  const queueStore = new RenderQueueUiStore(client, {
    request(callback) {
      frames.push(callback);
      return frames.length;
    },
    cancel: vi.fn(),
  });
  return { client, queueStore, flush: () => frames.shift()?.() };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem("aster.locale", "en-US");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  delete window.asterDesktop;
});

describe("RenderQueuePanel", () => {
  it("restores persisted jobs and exposes status-safe actions", async () => {
    const context = harness();
    act(() => {
      root.render(
        <I18nProvider>
          <RenderQueuePanel queueStore={context.queueStore} />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      context.flush();
    });
    expect(container.textContent).toContain("Composition active");
    expect(container.textContent).toContain("Encoder stopped");
    expect(container.textContent).toContain("Completed");
    const removeButtons = [
      ...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove"]'),
    ];
    expect(removeButtons).toHaveLength(3);
    expect(removeButtons[0]?.disabled).toBe(true);
    expect(removeButtons[1]?.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Retry"]')).not.toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('.status-completed button[aria-label="Cancel"]'),
    ).toBeNull();
  });

  it("routes an enabled pause action through the process client", async () => {
    const context = harness();
    act(() => {
      root.render(
        <I18nProvider>
          <RenderQueuePanel queueStore={context.queueStore} />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      context.flush();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Pause"]')?.click();
      await Promise.resolve();
    });
    expect(context.client.command).toHaveBeenCalledWith({ type: "pause", jobId: "active" });
  });

  it("continues an active paused lease while keeping remove disabled", async () => {
    let state = enqueueRenderJob(createRenderQueue(), input("paused"));
    state = claimRenderJob(state, "paused", "paused-lease");
    state = markRenderJobRunning(state, "paused", "paused-lease");
    state = requestRenderPause(state, "paused");
    state = acknowledgeRenderPaused(state, "paused", "paused-lease");
    const context = harness(state);
    act(() => {
      root.render(
        <I18nProvider>
          <RenderQueuePanel queueStore={context.queueStore} />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      context.flush();
    });

    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove"]')?.disabled,
    ).toBe(true);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Resume"]')?.click();
      await Promise.resolve();
    });
    expect(context.client.command).toHaveBeenCalledWith({ type: "resume", jobId: "paused" });
  });

  it("keeps cancel available while a pause acknowledgement is pending", async () => {
    let state = enqueueRenderJob(createRenderQueue(), input("pausing"));
    state = claimRenderJob(state, "pausing", "pausing-lease");
    state = markRenderJobRunning(state, "pausing", "pausing-lease");
    state = requestRenderPause(state, "pausing");
    const context = harness(state);
    act(() => {
      root.render(
        <I18nProvider>
          <RenderQueuePanel queueStore={context.queueStore} />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      context.flush();
    });

    const cancel = container.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]');
    expect(cancel?.disabled).toBe(false);
    await act(async () => {
      cancel?.click();
      await Promise.resolve();
    });
    expect(context.client.command).toHaveBeenCalledWith({ type: "cancel", jobId: "pausing" });
  });

  it("routes retry and remove immediately from a cancelled row", async () => {
    let state = enqueueRenderJob(createRenderQueue(), input("cancelled"));
    state = cancelRenderJob(state, "cancelled");
    const context = harness(state);
    act(() => {
      root.render(
        <I18nProvider>
          <RenderQueuePanel queueStore={context.queueStore} />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      context.flush();
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Retry"]')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove"]')?.click();
      await Promise.resolve();
    });
    expect(context.client.command).toHaveBeenNthCalledWith(1, {
      type: "retry",
      jobId: "cancelled",
    });
    expect(context.client.command).toHaveBeenNthCalledWith(2, {
      type: "remove",
      jobId: "cancelled",
    });
  });

  it("exposes per-format output options and enqueues their mapped manifest", async () => {
    const context = harness();
    window.asterDesktop = {
      save: vi.fn(async () => "C:\\renders\\out.mp4"),
      migrateLegacyPreferences: vi.fn(async () => defaultAppPreferences()),
    } as unknown as AsterDesktopApi;
    act(() => {
      root.render(
        <I18nProvider>
          <EditorProvider>
            <RenderQueuePanel queueStore={context.queueStore} />
          </EditorProvider>
        </I18nProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      context.flush();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Add"]')?.click();
      await Promise.resolve();
    });
    const form = container.querySelector<HTMLFormElement>("form.render-queue-add");
    expect(form).not.toBeNull();
    const audio = form?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const bitrate = form?.querySelector<HTMLInputElement>('input[list="render-queue-bitrate"]');
    expect(audio).not.toBeNull();
    expect(bitrate?.value).toBe("20");
    const setInput = (input: HTMLInputElement | null | undefined, value: string) => {
      if (!input) throw new Error("Missing form input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    act(() => audio?.click());
    act(() => setInput(bitrate, "48"));
    const selects = [...(form?.querySelectorAll("select") ?? [])];
    const rangeSelect = selects[1];
    act(() => {
      rangeSelect.value = "custom";
      rangeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const numbers = [...(form?.querySelectorAll<HTMLInputElement>('input[type="number"]') ?? [])];
    act(() => setInput(numbers[1], "1"));
    act(() => setInput(numbers[2], "2"));
    expect(form?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() => expect(context.client.enqueue).toHaveBeenCalled());
    expect(context.client.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        startFrame: 60,
        endFrameExclusive: 120,
        outputs: [expect.objectContaining({ kind: "mp4", bitrateMbps: 48, includeAudio: true })],
      }),
    );
  });

  it("swaps the output controls when the format changes", async () => {
    const context = harness();
    window.asterDesktop = {
      migrateLegacyPreferences: vi.fn(async () => defaultAppPreferences()),
    } as unknown as AsterDesktopApi;
    act(() => {
      root.render(
        <I18nProvider>
          <EditorProvider>
            <RenderQueuePanel queueStore={context.queueStore} />
          </EditorProvider>
        </I18nProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      context.flush();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Add"]')?.click();
      await Promise.resolve();
    });
    const form = container.querySelector<HTMLFormElement>("form.render-queue-add");
    const formatSelect = form?.querySelector("select");
    if (!formatSelect) throw new Error("Missing format selector");
    act(() => {
      formatSelect.value = "pngSequence";
      formatSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(form?.querySelector('input[type="checkbox"]')).toBeNull();
    const pattern = form?.querySelector<HTMLInputElement>('input[type="text"]');
    expect(pattern?.value).toBe("frame_[######].png");
    const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        pattern,
        "bad/frame.png",
      );
      pattern?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(submit?.disabled).toBe(true);
  });
});
