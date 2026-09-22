// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankComposition } from "../../core/project/project";
import { ViewportTextEditor, viewportTextEditorStyle } from "./ViewportTextEditor";

let root: Root | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe("ViewportTextEditor", () => {
  it("keeps overflowing lines editable around the original centered baseline", () => {
    const layer = createLayerForComposition("text", createBlankComposition());
    layer.size = [400, 50];
    if (!layer.textStyle) throw new Error("Expected text style");
    layer.textStyle = { ...layer.textStyle, fontSize: 40, leading: 50 };
    const style = viewportTextEditorStyle(
      layer,
      "One\nTwo\nThree",
      2,
      "matrix(0, 1, -1, 0, 960, 540)",
    );
    expect(style.height).toBe("300px");
    expect(style.paddingTop).toBe("0px");
    expect(style.transform).toBe("matrix(0, 1, -1, 0, 960, 540) translateY(-100px)");
    expect(layer.size).toEqual([400, 50]);
  });
  it("keeps the glyph overlay transparent while matching typography and transformed zoom", () => {
    const layer = createLayerForComposition("text", createBlankComposition());
    layer.size = [400, 200];
    if (!layer.textStyle) throw new Error("Expected text style");
    layer.textStyle = {
      ...layer.textStyle,
      alignment: "right",
      fontFamily: "Inter",
      fontSize: 40,
      fontWeight: 700,
      fontStyle: "italic",
      leading: 50,
      tracking: 4,
    };
    const editor = renderEditor(layer, "One\nTwo", {
      transformMatrix: "matrix(1.5, 0, 0, -0.75, 960, 540)",
      zoom: 4,
    });

    const presentation = viewportTextEditorStyle(
      layer,
      "One\nTwo",
      4,
      "matrix(1.5, 0, 0, -0.75, 960, 540)",
    );
    expect(presentation.color).toBe("transparent");
    expect(presentation.WebkitTextFillColor).toBe("transparent");
    expect(presentation.caretColor).toBe("#ffffff");
    expect(editor.style.fontFamily).toBe("Inter");
    expect(editor.style.fontSize).toBe("160px");
    expect(editor.style.fontWeight).toBe("700");
    expect(editor.style.fontStyle).toBe("italic");
    expect(editor.style.letterSpacing).toBe("16px");
    expect(editor.style.lineHeight).toBe("200px");
    expect(editor.style.paddingLeft).toBe("48px");
    expect(editor.style.paddingTop).toBe("200px");
    expect(editor.style.textAlign).toBe("right");
    expect(editor.style.transform).toBe("matrix(1.5, 0, 0, -0.75, 960, 540)");
    expect(editor.style.width).toBe("1600px");
    expect(editor.style.height).toBe("800px");
  });

  it("streams input and maps commit plus Escape rollback gestures", () => {
    const layer = createLayerForComposition("text", createBlankComposition());
    const onCancel = vi.fn();
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const editor = renderEditor(layer, "Start", { onCancel, onChange, onCommit });

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        editor,
        "Live GPU text",
      );
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("Live GPU text");

    act(() =>
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "Enter" }),
      ),
    );
    expect(onCommit).toHaveBeenCalledTimes(1);

    act(() => editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

function renderEditor(
  layer: ReturnType<typeof createLayerForComposition>,
  value: string,
  options: {
    onCancel?: () => void;
    onChange?: (value: string) => void;
    onCommit?: () => void;
    transformMatrix?: string;
    zoom?: number;
  } = {},
): HTMLTextAreaElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <ViewportTextEditor
        label="Edit title"
        layer={layer}
        onCancel={options.onCancel ?? vi.fn()}
        onChange={options.onChange ?? vi.fn()}
        onCommit={options.onCommit ?? vi.fn()}
        transformMatrix={options.transformMatrix ?? "matrix(1, 0, 0, 1, 0, 0)"}
        value={value}
        zoom={options.zoom ?? 1}
      />,
    ),
  );
  const editor = container.querySelector("textarea");
  if (!(editor instanceof HTMLTextAreaElement)) throw new Error("Expected viewport text editor");
  return editor;
}
