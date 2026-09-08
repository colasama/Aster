// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankProject } from "../../core/project/project";
import type { Project } from "../../core/types";
import { I18nProvider } from "../../i18n/react";
import { EditorProvider, useEditor } from "../../state/editor-store";
import { ProjectPanel } from "./ProjectPanel";

vi.mock("../../core/plugins/plugins", () => ({
  readPluginStatus: () => new Promise(() => undefined),
}));

let root: Root | undefined;
let currentProject: Project | undefined;

function LoadProject({ project }: { project: Project }) {
  const { dispatch } = useEditor();
  useEffect(() => dispatch({ type: "loadProject", project }), [dispatch, project]);
  return null;
}

function CaptureProject() {
  currentProject = useEditor().state.project;
  return null;
}

function renderPanel(project: Project): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <I18nProvider>
        <EditorProvider>
          <LoadProject project={project} />
          <CaptureProject />
          <ProjectPanel />
        </EditorProvider>
      </I18nProvider>,
    ),
  );
  return container;
}

function dragItem(source: Element, destination: Element): void {
  const values = new Map<string, string>();
  const dataTransfer = {
    dropEffect: "none",
    effectAllowed: "none",
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => values.set(type, value),
  };
  for (const [element, type] of [
    [source, "dragstart"],
    [destination, "dragenter"],
    [destination, "drop"],
  ] as const) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    element.dispatchEvent(event);
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem("aster.locale", "en-US");
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  currentProject = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("project Assets panel", () => {
  it("keeps the effect preset draft when switching tabs without mounting hidden catalog rows", () => {
    const container = renderPanel(createBlankProject());
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(container.querySelector(".effect-list")).toBeNull();
    act(() => tabs[1].click());
    const input = container.querySelector<HTMLInputElement>(".user-preset-save input");
    if (!input) throw new Error("Expected the preset name input");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "My draft look",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => tabs[0].click());
    expect(container.querySelector(".effect-list")).toBeNull();
    act(() => tabs[1].click());
    expect(container.querySelector<HTMLInputElement>(".user-preset-save input")?.value).toBe(
      "My draft look",
    );
  });

  it("opens the add dropdown and folds the Assets root", () => {
    const container = renderPanel(createBlankProject());
    const addButton = container.querySelector<HTMLButtonElement>('button[aria-label="Add item"]');
    act(() => addButton?.click());
    expect(container.textContent).toContain("Add to project");
    expect(container.querySelector(".asset-add-menu")).not.toBeNull();
    expect(container.querySelector(".asset-add-overlay")).toBeNull();
    expect(container.textContent).toContain("Composition");
    expect(container.textContent).toContain("Folder");

    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Close add menu"]')?.click(),
    );
    expect(container.querySelector(".tree-row.composition")).not.toBeNull();
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Collapse Assets"]')?.click(),
    );
    expect(container.querySelector(".tree-row.composition")).toBeNull();
    expect(container.querySelector('button[aria-label="Expand Assets"]')).not.toBeNull();
  });

  it("creates folders and compositions from the add dropdown", () => {
    const container = renderPanel(createBlankProject());
    const addButton = container.querySelector<HTMLButtonElement>('button[aria-label="Add item"]');
    act(() => addButton?.click());
    const folderButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Folder",
    );
    act(() => folderButton?.click());
    expect(currentProject?.folders).toHaveLength(1);
    expect(container.textContent).toContain("Folder 1");

    act(() => addButton?.click());
    const compositionButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Composition",
    );
    act(() => compositionButton?.click());
    expect(currentProject?.compositions).toHaveLength(2);
    expect(currentProject?.compositions[1]?.name).toBe("Composition 2");
  });

  it("moves project items into a folder and opens that folder's targeted add dropdown", () => {
    const project = createBlankProject();
    const folder = { id: crypto.randomUUID(), name: "Shots" };
    project.folders.push(folder);
    const container = renderPanel(project);
    const compositionRow = container.querySelector(".tree-row.composition");
    const folderRow = container.querySelector('.asset-folder-node > [role="treeitem"]');
    expect(compositionRow).not.toBeNull();
    expect(folderRow).not.toBeNull();

    act(() => dragItem(compositionRow as Element, folderRow as Element));
    expect(currentProject?.itemFolderIds[project.activeCompositionId]).toBe(folder.id);
    expect(container.querySelector(".tree-row.composition")).not.toBeNull();
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Collapse Shots"]')?.click(),
    );
    expect(container.querySelector(".tree-row.composition")).toBeNull();
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Expand Shots"]')?.click(),
    );
    expect(container.querySelector(".tree-row.composition")).not.toBeNull();

    const addToFolder = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add to Shots"]',
    );
    act(() => addToFolder?.click());
    expect(container.textContent).toContain("Destination · Shots");
  });

  it("opens composition actions by pointer and keyboard without duplicating command logic", () => {
    const container = renderPanel(createBlankProject());
    const compositionRow = container.querySelector<HTMLButtonElement>(".tree-row.composition");
    expect(compositionRow).not.toBeNull();

    act(() =>
      compositionRow?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 80,
          clientY: 90,
        }),
      ),
    );
    const menu = document.querySelector<HTMLElement>(
      '[role="menu"][aria-label="Project item menu"]',
    );
    expect(menu).not.toBeNull();
    const duplicate = [
      ...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
    ].find((button) => button.textContent?.includes("Duplicate"));
    act(() => duplicate?.click());
    expect(currentProject?.compositions).toHaveLength(2);
    expect(currentProject?.compositions[1]?.name).toBe("Composition 1 Copy");

    const duplicatedRow = [
      ...container.querySelectorAll<HTMLButtonElement>(".tree-row.composition"),
    ].find((row) => row.textContent?.includes("Composition 1 Copy"));
    act(() =>
      duplicatedRow?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ContextMenu" }),
      ),
    );
    const keyboardMenu = document.querySelector<HTMLElement>(
      '[role="menu"][aria-label="Project item menu"]',
    );
    expect(keyboardMenu).not.toBeNull();
    act(() =>
      keyboardMenu?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
      ),
    );
    expect(document.querySelector('[role="menu"][aria-label="Project item menu"]')).toBeNull();
  });
});
