// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AutomationSettings, AutomationSettingsApi } from "../../desktop/automation-settings";
import { I18nProvider } from "../../i18n/react";
import { AutomationSettingsPanel } from "./AutomationSettingsPanel";

let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem("aster.locale", "en-US");
});
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  localStorage.clear();
});
async function mount(overrides: Partial<AutomationSettings> = {}) {
  let state: AutomationSettings = {
    enabled: false,
    port: 48765,
    running: false,
    clients: 0,
    busy: false,
    environmentManaged: false,
    ...overrides,
  };
  const api: AutomationSettingsApi = {
    get: vi.fn(async () => state),
    update: vi.fn(async (patch) => {
      state = { ...state, ...patch, running: patch.enabled ?? state.enabled };
      return state;
    }),
    copy: vi.fn(async () => undefined),
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <I18nProvider>
        <AutomationSettingsPanel api={api} />
      </I18nProvider>,
    ),
  );
  return { api, container };
}
function button(text: string) {
  const result = [...document.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}

it("enables immediately and copies a client configuration without credentials", async () => {
  const { api, container } = await mount();
  expect(button("Copy client configuration").disabled).toBe(false);
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click(),
  );
  expect(api.update).toHaveBeenCalledWith({ enabled: true });
  expect(container.textContent).toContain("Listening · 0 clients");
  await act(async () => button("Copy client configuration").click());
  expect(api.copy).toHaveBeenCalledWith("configuration");
  expect(button("Copied")).toBeTruthy();
  expect(container.textContent).not.toContain("Token");
});

it("keeps environment-managed settings read-only while allowing configuration copy", async () => {
  const { container } = await mount({
    enabled: true,
    running: true,
    environmentManaged: true,
  });
  expect([...container.querySelectorAll("input")].every((input) => input.disabled)).toBe(true);
  expect(button("Copy client configuration").disabled).toBe(false);
  expect(container.textContent).toContain("Controlled by environment variables");
});

it("keeps the applied switch state and displays a failed change", async () => {
  const { api, container } = await mount();
  vi.mocked(api.update).mockRejectedValueOnce(new Error("Port is already in use"));
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click(),
  );
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Port is already in use",
  );
});
