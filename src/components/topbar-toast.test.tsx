// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TopBarToastController, toastMessage, useTopBarToast } from "./topbar-toast";

let controller: TopBarToastController | undefined;
let root: Root | undefined;

function Harness() {
  controller = useTopBarToast(1000);
  return <output>{controller.toast?.id ?? "empty"}</output>;
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  controller = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("top bar toast ownership", () => {
  it("ignores an older request that resolves after a newer toast", () => {
    const oldRequest = controller?.beginRequest();
    const newRequest = controller?.beginRequest();
    act(() => {
      expect(controller?.show(toastMessage("topbar.toast.recovered"), newRequest)).toBe(true);
    });
    const currentId = controller?.toast?.id;
    act(() => {
      expect(controller?.show(toastMessage("topbar.toast.noRecovery"), oldRequest)).toBe(false);
    });
    expect(controller?.toast?.id).toBe(currentId);
    expect(controller?.toast?.descriptor).toEqual(toastMessage("topbar.toast.recovered"));
  });

  it("uses one timer so an old timeout cannot clear a newer toast", () => {
    act(() => {
      controller?.show(toastMessage("topbar.toast.recovered"));
      vi.advanceTimersByTime(600);
      controller?.show(toastMessage("topbar.toast.noRecovery"));
    });
    const currentId = controller?.toast?.id;

    act(() => vi.advanceTimersByTime(400));
    expect(controller?.toast?.id).toBe(currentId);

    act(() => vi.advanceTimersByTime(600));
    expect(controller?.toast).toBeUndefined();
  });
});
