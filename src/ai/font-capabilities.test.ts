// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { applyOperations } from "../core/operations";
import { createBlankProject } from "../core/project";
import {
  openPersistedProjectDocument,
  serializeProject,
  validateProjectDocument,
} from "../core/project-file";
import { type ProjectFont, validateProjectFonts } from "../core/project-fonts";
import * as system from "../desktop/fonts";
import { createInitialState, editorReducer } from "../state/editor-store";
import { AsterAgentApplicationService } from "./application-service";
import { AutomationApplicationService } from "./automation-service";
import { normalizeAiCommands } from "./command-normalizer";
import { checkFonts, listFonts } from "./font-tools";

const font = (): ProjectFont => ({
  id: crypto.randomUUID(),
  name: "Title.ttf",
  family: "Title Font",
  weight: 400,
  dataUrl: "data:font/ttf;base64,AAEAAA==",
});
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
function mockFonts() {
  const loaded = vi.fn(async function (this: object) {
    return this;
  });
  vi.stubGlobal(
    "FontFace",
    class {
      load = loaded;
    },
  );
  const fontSet = Object.assign(new Set(), { ready: Promise.resolve() });
  Object.defineProperty(document, "fonts", { configurable: true, value: fontSet });
  return { loaded, fontSet };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
});

describe("font capabilities", () => {
  it("reads complete text styles and patches only supplied fields", async () => {
    const project = createBlankProject();
    const text = createLayerForComposition("text", project.compositions[0]);
    project.compositions[0].layers.push(text);
    const service = new AsterAgentApplicationService({
      project,
      projectRevision: 0,
      selection: [text.id],
      currentTime: 0,
      accessMode: "agent",
      primaryModelSupportsImages: false,
    });
    for (const kind of ["layers", "properties"]) {
      const result = (await service.executeTool("query_project", { projectRevision: 0, kind })) as {
        items: { id: string; textStyle: unknown }[];
      };
      expect(result.items.find((item) => item.id === text.id)?.textStyle).toEqual(text.textStyle);
    }
    const changed = normalizeAiCommands(
      [{ type: "setTextStyle", layerId: text.id, textStyle: { fontFamily: "Georgia" } }],
      project,
      0,
    );
    expect(
      changed.project.compositions[0].layers.find((layer) => layer.id === text.id)?.textStyle,
    ).toEqual({ ...text.textStyle, fontFamily: "Georgia" });
    expect(() =>
      normalizeAiCommands([{ type: "setTextStyle", layerId: text.id, textStyle: {} }], project, 0),
    ).toThrow("at least one");
    expect(() =>
      normalizeAiCommands(
        [{ type: "setTextStyle", layerId: text.id, textStyle: { fontSize: 0 } }],
        project,
        0,
      ),
    ).toThrow();
    expect(text.textStyle?.fontFamily).not.toBe("Georgia");
  });

  it("persists embedded fonts, loads them on reopen, and exposes metadata without bytes", async () => {
    const { loaded } = mockFonts();
    const project = applyOperations(createBlankProject(), [
      { type: "addProjectFont", font: font() },
    ]);
    const reopened = await openPersistedProjectDocument(JSON.parse(serializeProject(project)));
    expect(reopened.fonts).toEqual(project.fonts);
    expect(loaded).toHaveBeenCalledTimes(1);
    const service = new AsterAgentApplicationService({
      project: reopened,
      projectRevision: 0,
      selection: [],
      currentTime: 0,
      accessMode: "agent",
      primaryModelSupportsImages: false,
    });
    const result = await service.executeTool("query_project", {
      projectRevision: 0,
      kind: "fonts",
    });
    expect(JSON.stringify(result)).toContain("Title Font");
    expect(JSON.stringify(result)).not.toContain("dataUrl");
    expect(validateProjectDocument(createBlankProject()).fonts).toBeUndefined();
    expect(
      applyOperations(project, [{ type: "removeProjectFont", fontId: project.fonts?.[0].id ?? "" }])
        .fonts,
    ).toEqual([]);
    expect(project.fonts).toHaveLength(1);
  });

  it("rejects duplicate faces, invalid metadata and oversized data", () => {
    const first = font();
    expect(() => validateProjectFonts([first, { ...first, id: "second" }])).toThrow("Duplicate");
    expect(() =>
      validateProjectFonts([{ ...first, dataUrl: "https://example.com/font.ttf" }]),
    ).toThrow();
    expect(() => validateProjectFonts([{ ...first, weight: 0 }])).toThrow();
    expect(() => validateProjectFonts([{ ...first, weightRange: [100, 900] }])).not.toThrow();
    expect(() => validateProjectFonts([{ ...first, weightRange: [500, 900] }])).toThrow("range");
    expect(() =>
      validateProjectFonts([
        { ...first, weightRange: [100, 900] },
        { ...first, id: "bold", weight: 700 },
      ]),
    ).toThrow("Overlapping");
    expect(() =>
      validateProjectFonts([
        { ...first, dataUrl: `data:font/ttf;base64,${"AAAA".repeat(3 * 1024 * 1024)}` },
      ]),
    ).toThrow("budget");
  });

  it("lists/filter/pages actual system faces and distinguishes project font availability", async () => {
    mockFonts();
    vi.spyOn(system, "listSystemFonts").mockResolvedValue([
      { family: "Arial", fullName: "Arial", postscriptName: "ArialMT", style: "Regular" },
      { family: "Arial", fullName: "Arial Bold", postscriptName: "Arial-BoldMT", style: "Bold" },
    ]);
    const project = { ...createBlankProject(), fonts: [font()] };
    const first = await listFonts(project, { query: "Arial", limit: 1 });
    expect(first).toMatchObject({ total: 2, nextOffset: 1 });
    expect(
      (await listFonts(project, { query: "Arial", offset: 1, limit: 1 })).nextOffset,
    ).toBeNull();
    const checked = await checkFonts(project, ["arial", "Title Font", "missing", "SERIF"]);
    expect(checked.fonts.map(({ available, method }) => ({ available, method }))).toEqual([
      { available: true, method: "system-inventory" },
      { available: true, method: "project-font" },
      { available: false, method: "system-inventory" },
      { available: true, method: "generic-family" },
    ]);
    expect(JSON.stringify(await listFonts(project, { source: "project" }))).not.toContain(
      "dataUrl",
    );
  });

  it("imports atomically, undoes the import and rejects stale or undecodable fonts", async () => {
    const { loaded } = mockFonts();
    let state = createInitialState();
    const service = new AutomationApplicationService({
      read: () => state,
      markSaved: () => {},
      loadProject: () => {},
      commit: (operations) => {
        state = editorReducer(state, { type: "operation", operations });
      },
    });
    const call = (fontValue: ProjectFont, baseRevision = state.projectRevision) =>
      service.execute({
        requestId: "font",
        clientId: "font",
        name: "import_font",
        arguments: { font: fontValue, baseRevision },
      });
    const imported = font();
    await expect(call(imported)).resolves.toMatchObject({ font: { id: imported.id } });
    expect(state.project.fonts).toEqual([imported]);
    state = editorReducer(state, { type: "undo" });
    expect(state.project.fonts).toBeUndefined();
    await expect(call(font(), 0)).rejects.toThrow("Stale");
    loaded.mockRejectedValueOnce(new Error("invalid font"));
    await expect(call(font())).rejects.toThrow("Cannot decode");
    expect(state.project.fonts).toBeUndefined();
    let finish!: (value: object) => void;
    loaded.mockImplementationOnce(
      () =>
        new Promise<object>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = call(font());
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    state = { ...state, projectRevision: state.projectRevision + 1 };
    finish({});
    await expect(pending).rejects.toThrow("Stale");
    expect(state.project.fonts).toBeUndefined();
  });
});
