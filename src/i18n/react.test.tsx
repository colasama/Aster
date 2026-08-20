// @vitest-environment happy-dom

import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY } from "./core";
import { translateUiMessage, uiError } from "./errors";
import { I18nProvider, syncDocumentLocale, useI18n } from "./react";

let root: Root | undefined;

function Probe({ onMount }: { onMount: () => void }) {
  const { locale, setLocale, t } = useI18n();
  const [existingError] = useState(() => uiError("aiRequest"));
  useEffect(onMount, [onMount]);
  return (
    <div>
      <output data-testid="locale">{locale}</output>
      <output data-testid="label">{t("topbar.menu.file")}</output>
      <output data-testid="error">{translateUiMessage(t, existingError)}</output>
      <button onClick={() => setLocale("en-US")} type="button">
        English
      </button>
      <button onClick={() => setLocale("zh-CN")} type="button">
        Chinese
      </button>
    </div>
  );
}

function renderProbe(onMount = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<I18nProvider>{<Probe onMount={onMount} />}</I18nProvider>));
  return { container, onMount };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  document.documentElement.removeAttribute("lang");
});

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("I18nProvider", () => {
  it("updates locale, storage, and document language without remounting children", () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en-US");
    const { container, onMount } = renderProbe();
    expect(container.querySelector('[data-testid="label"]')?.textContent).toBe("File");
    expect(container.querySelector('[data-testid="error"]')?.textContent).toContain("AI operation");
    expect(document.documentElement.lang).toBe("en-US");

    act(() => container.querySelectorAll("button")[1]?.click());

    expect(container.querySelector('[data-testid="locale"]')?.textContent).toBe("zh-CN");
    expect(container.querySelector('[data-testid="label"]')?.textContent).toBe("文件");
    expect(container.querySelector('[data-testid="error"]')?.textContent).toContain("AI 操作");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(onMount).toHaveBeenCalledTimes(1);
  });

  it("keeps localization usable when storage access throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const { container } = renderProbe();

    expect(container.querySelector('[data-testid="label"]')?.textContent).toBe("File");
    expect(() => act(() => container.querySelectorAll("button")[1]?.click())).not.toThrow();
    expect(container.querySelector('[data-testid="label"]')?.textContent).toBe("文件");
  });

  it("guards document synchronization for non-DOM renderers", () => {
    vi.stubGlobal("document", undefined);
    expect(() => syncDocumentLocale("zh-CN")).not.toThrow();
  });
});
