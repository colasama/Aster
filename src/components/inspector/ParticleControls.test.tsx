// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultParticleSettings,
  type ParticleSettings,
} from "../../core/scene/particle-settings";
import { I18nProvider } from "../../i18n/react";
import { ParticleControls } from "./ParticleControls";

let root: Root | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem("aster.locale", "en-US");
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("GPU particle inspector", () => {
  it("exposes emitter, physics, life, and streak controls", () => {
    const settings: ParticleSettings = {
      ...createDefaultParticleSettings(),
      renderMode: "streak",
      startColor: [4, 2, 1],
    };
    const onChange = vi.fn();
    const container = renderControls(settings, onChange);

    expect(container.textContent).toContain("Emitter");
    expect(container.textContent).toContain("Physics");
    expect(container.textContent).toContain("Over life");
    expect(container.querySelector('option[value="streak"]')?.textContent).toBe("Streak");
    expect(container.querySelector('input[aria-label="Streak length"]')).not.toBeNull();

    const emitter = container.querySelector(
      'select[aria-label="Particle emitter shape"]',
    ) as HTMLSelectElement;
    act(() => {
      emitter.value = "ring";
      emitter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ emitterShape: "ring" }));
  });

  it("keeps HDR RGB channels numeric instead of silently clamping through a color picker", () => {
    const container = renderControls({
      ...createDefaultParticleSettings(),
      startColor: [4, 2, 1],
    });
    const red = container.querySelector(
      'input[aria-label="Start color (HDR) R"]',
    ) as HTMLInputElement;
    expect(red.type).toBe("number");
    expect(red.max).toBe("16");
    expect(red.value).toBe("4");
    expect(container.querySelector('input[type="color"]')).toBeNull();
  });

  it("renders the complete inspector in Chinese", () => {
    window.localStorage.setItem("aster.locale", "zh-CN");
    const container = renderControls(createDefaultParticleSettings());
    expect(container.textContent).toContain("发射器");
    expect(container.textContent).toContain("物理");
    expect(container.textContent).toContain("生命周期变化");
    expect(container.textContent).toContain("起始颜色（HDR）");
  });
});

function renderControls(
  settings: ParticleSettings,
  onChange: (settings: ParticleSettings) => void = () => undefined,
): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <I18nProvider>
        <ParticleControls onChange={onChange} settings={settings} />
      </I18nProvider>,
    ),
  );
  return container;
}
