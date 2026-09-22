import { type CSSProperties, type KeyboardEvent, type Ref, useMemo } from "react";
import type { Layer } from "../../core/types";
import { breakTextLines, resolveTextStyle } from "../../renderer/text/text-rasterizer";

interface ViewportTextEditorProps {
  readonly label: string;
  readonly layer: Layer;
  readonly onCancel: () => void;
  readonly onChange: (value: string) => void;
  readonly onCommit: () => void;
  readonly ref?: Ref<HTMLTextAreaElement>;
  readonly transformMatrix: string;
  readonly value: string;
  readonly zoom: number;
}

export function ViewportTextEditor({
  label,
  layer,
  onCancel,
  onChange,
  onCommit,
  ref,
  transformMatrix,
  value,
  zoom,
}: ViewportTextEditorProps) {
  const style = useMemo(
    () => viewportTextEditorStyle(layer, value, zoom, transformMatrix),
    [layer, transformMatrix, value, zoom],
  );
  return (
    <textarea
      aria-label={label}
      className="viewport-text-editor"
      maxLength={20_000}
      onBlur={onCommit}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => handleTextEditorKeyDown(event, onCommit, onCancel)}
      onPointerDown={(event) => event.stopPropagation()}
      ref={ref}
      spellCheck="true"
      style={style}
      value={value}
      wrap="soft"
    />
  );
}

export function viewportTextEditorStyle(
  layer: Layer,
  value: string,
  zoom: number,
  transformMatrix: string,
): CSSProperties {
  const style = resolveTextStyle(layer);
  const lineCount = measureVisualLineCount(layer, value, style);
  const contentHeight = lineCount * style.leading;
  const overflowOffset = Math.min(0, (layer.size[1] - contentHeight) / 2) * zoom;
  const verticalInset = Math.max(0, (layer.size[1] - lineCount * style.leading) / 2) * zoom;
  const horizontalInset = layer.size[0] * 0.03 * zoom;
  return {
    WebkitTextFillColor: "transparent",
    caretColor: "#ffffff",
    color: "transparent",
    fontFamily: style.fontFamily,
    fontSize: `${style.fontSize * zoom}px`,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle ?? "normal",
    height: `${Math.max(layer.size[1], contentHeight) * zoom}px`,
    left: 0,
    letterSpacing: `${style.tracking * zoom}px`,
    lineHeight: `${style.leading * zoom}px`,
    paddingBottom: 0,
    paddingLeft: `${horizontalInset}px`,
    paddingRight: `${horizontalInset}px`,
    paddingTop: `${verticalInset}px`,
    textAlign: style.alignment,
    top: 0,
    transform:
      overflowOffset === 0 ? transformMatrix : `${transformMatrix} translateY(${overflowOffset}px)`,
    transformOrigin: "0 0",
    width: `${layer.size[0] * zoom}px`,
  };
}

function handleTextEditorKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  commit: () => void,
  cancel: () => void,
): void {
  if (event.nativeEvent.isComposing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    cancel();
  } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    commit();
  }
}

let measurementCanvas: HTMLCanvasElement | undefined;

function measureVisualLineCount(
  layer: Layer,
  value: string,
  style: ReturnType<typeof resolveTextStyle>,
): number {
  try {
    measurementCanvas ??= document.createElement("canvas");
    const context = measurementCanvas.getContext("2d");
    if (context) {
      context.font = `${style.fontStyle ?? "normal"} ${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
      return Math.max(
        1,
        breakTextLines(
          value,
          layer.size[0] * 0.94,
          (text) => context.measureText(text).width,
          style.tracking,
        ).length,
      );
    }
  } catch {
    // DOM-only test environments may not provide a canvas context.
  }
  return Math.max(1, value.split(/\r?\n/).length);
}
