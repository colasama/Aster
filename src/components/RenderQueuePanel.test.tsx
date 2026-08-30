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
} from "../core/render-queue";
import { I18nProvider } from "../i18n/react";
import { type RenderQueueClient, RenderQueueUiStore } from "../render-queue/render-queue-store";
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
});
