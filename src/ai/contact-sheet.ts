import {
  type ContactSheet,
  type ContactSheetRequest,
  contactSheetLayout,
  GAP,
  LABEL_HEIGHT,
} from "./contact-sheet-spec";

export {
  type ContactSheet,
  type ContactSheetRequest,
  contactSheetTimes,
  formatSheetTime,
} from "./contact-sheet-spec";

export interface ContactSheetCellInput {
  time: number;
  label: string;
  image: ImageData | ImageBitmap;
}

/** Draws cells row-major with a time label strip above each image. */
export async function composeContactSheet(
  cells: readonly ContactSheetCellInput[],
  request: ContactSheetRequest,
): Promise<ContactSheet> {
  if (cells.length === 0) throw new Error("Contact sheet requires at least one cell");
  const first = cells[0].image;
  const layout = contactSheetLayout(request, cells.length, first.height / first.width);
  const width = layout.columns * (layout.cellWidth + GAP) - GAP;
  const height = layout.rows * (layout.cellHeight + GAP) - GAP;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Contact sheet canvas is unavailable");
  context.fillStyle = "#111";
  context.fillRect(0, 0, width, height);
  context.font = "12px ui-monospace, Consolas, monospace";
  context.textBaseline = "middle";
  const placed: ContactSheet["cells"] = [];
  for (const [index, cell] of cells.entries()) {
    const x = (index % layout.columns) * (layout.cellWidth + GAP);
    const y = Math.floor(index / layout.columns) * (layout.cellHeight + GAP);
    context.fillStyle = "#e8e8e8";
    context.fillText(cell.label, x + 4, y + LABEL_HEIGHT / 2);
    const source =
      cell.image instanceof ImageData ? await createImageBitmap(cell.image) : cell.image;
    const scale = Math.min(layout.cellWidth / source.width, layout.imageHeight / source.height);
    const drawWidth = Math.max(1, Math.round(source.width * scale));
    const drawHeight = Math.max(1, Math.round(source.height * scale));
    const imageX = x + Math.floor((layout.cellWidth - drawWidth) / 2);
    const imageY = y + LABEL_HEIGHT + Math.floor((layout.imageHeight - drawHeight) / 2);
    context.drawImage(source, imageX, imageY, drawWidth, drawHeight);
    if (source !== cell.image) source.close();
    placed.push({
      time: cell.time,
      label: cell.label,
      x: imageX,
      y: imageY,
      width: drawWidth,
      height: drawHeight,
    });
  }
  const blob = await new Promise<Blob | undefined>((resolve) =>
    canvas.toBlob((value) => resolve(value ?? undefined), "image/png"),
  );
  if (!blob) throw new Error("Contact sheet PNG encoding failed");
  if (blob.size > 12 * 1024 * 1024)
    throw new Error("Contact sheet exceeded 12 MiB; reduce count or cellWidth");
  return {
    mimeType: "image/png",
    data: await blobToBase64(blob),
    width,
    height,
    columns: layout.columns,
    rows: layout.rows,
    cells: placed,
  };
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
}
