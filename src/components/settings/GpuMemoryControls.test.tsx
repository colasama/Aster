// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GpuMemoryBudgetMb, GpuMemorySnapshot } from "../../core/rendering/gpu-memory-policy";
import * as memoryApi from "../../desktop/gpu-memory";
import { I18nProvider } from "../../i18n/react";
import { GpuMemoryControls } from "./GpuMemoryControls";

let root: Root;
let container: HTMLDivElement;
const detected: GpuMemorySnapshot = {
  adapterKey: "gpu",
  detectedAt: 0,
  device: { name: "Test GPU", totalMb: 8192, freeMb: 6000, kind: "dedicated" },
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem("aster.locale", "en-US");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(memoryApi, "currentGpuMemory").mockReturnValue(detected);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function render(initial: GpuMemoryBudgetMb = "auto") {
  function Harness() {
    const [value, setValue] = useState(initial);
    const [valid, setValid] = useState(true);
    return (
      <I18nProvider>
        <GpuMemoryControls value={value} onChange={setValue} onValidityChange={setValid} />
        <button disabled={!valid} data-save="true" type="button">
          Save
        </button>
        <output>{value}</output>
      </I18nProvider>
    );
  }
  act(() => root.render(<Harness />));
}

function input(value: string) {
  const target = container.querySelector("input");
  if (!target) throw new Error("Missing manual input");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("GPU budget settings", () => {
  it("shows the automatic budget and accepts manual physical capacity without deducting reserves", () => {
    render();
    expect(container.textContent).toContain("Auto · 4096 MiB");
    const select = container.querySelector("select");
    if (!select) throw new Error("Missing mode selector");
    act(() => {
      select.value = "manual";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    input("8192");
    expect(container.querySelector("output")?.textContent).toBe("8192");
    expect(container.querySelector<HTMLButtonElement>("[data-save]")?.disabled).toBe(false);
    expect(container.textContent).toContain("no reserve");
  });
  it("blocks empty, fractional and over-capacity values without changing the last valid budget", () => {
    render(6144);
    for (const invalid of ["", "8193", "32.5", "0"]) {
      input(invalid);
      expect(container.querySelector<HTMLButtonElement>("[data-save]")?.disabled).toBe(true);
      expect(container.querySelector("output")?.textContent).toBe("6144");
    }
    input("7168");
    expect(container.querySelector<HTMLButtonElement>("[data-save]")?.disabled).toBe(false);
  });
  it("refreshes memory only on request and announces the new snapshot", async () => {
    const probe = vi.spyOn(memoryApi, "detectGpuMemory").mockResolvedValue({
      ...detected,
      device: {
        ...detected.device,
        name: "Test GPU",
        totalMb: 8192,
        freeMb: 3500,
        kind: "dedicated",
      },
    });
    const changed = vi.fn();
    window.addEventListener(memoryApi.GPU_MEMORY_CHANGED_EVENT, changed);
    render();
    expect(probe).not.toHaveBeenCalled();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[aria-label]")?.click();
    });
    expect(container.textContent).toContain("Auto · 2048 MiB");
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener(memoryApi.GPU_MEMORY_CHANGED_EVENT, changed);
  });
  it("disables manual mode if physical capacity cannot be detected", () => {
    vi.mocked(memoryApi.currentGpuMemory).mockReturnValue({ adapterKey: "unknown", detectedAt: 0 });
    render();
    expect(container.querySelector<HTMLOptionElement>('option[value="manual"]')?.disabled).toBe(
      true,
    );
    expect(container.textContent).toContain("conservative fallback");
  });
});
