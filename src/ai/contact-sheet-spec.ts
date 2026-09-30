import { Type } from "typebox";

export const MAX_CONTACT_SHEET_CELLS = 64;
const MAX_SHEET_EDGE = 4096;
export const LABEL_HEIGHT = 18;
export const GAP = 2;

export const contactSheetField = Type.Optional(
  Type.Object(
    {
      start: Type.Optional(Type.Number({ minimum: 0, maximum: 86_400 })),
      end: Type.Optional(Type.Number({ minimum: 0, maximum: 86_400 })),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CONTACT_SHEET_CELLS })),
      interval: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 86_400 })),
      times: Type.Optional(
        Type.Array(Type.Number({ minimum: 0, maximum: 86_400 }), {
          minItems: 1,
          maxItems: MAX_CONTACT_SHEET_CELLS,
        }),
      ),
      columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
      cellWidth: Type.Optional(Type.Integer({ minimum: 64, maximum: 640 })),
    },
    {
      additionalProperties: false,
      description:
        "Tile many samples into one labeled image: explicit times, or start/end with count (default 12) or interval. Up to 64 cells.",
    },
  ),
);

export interface ContactSheetRequest {
  start?: number;
  end?: number;
  count?: number;
  interval?: number;
  times?: number[];
  columns?: number;
  cellWidth?: number;
}

export interface ContactSheet {
  mimeType: "image/png";
  data: string;
  width: number;
  height: number;
  columns: number;
  rows: number;
  cells: Array<{
    time: number;
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

/** Resolves sample times; start/end default to the given range (a composition or media span). */
export function contactSheetTimes(request: ContactSheetRequest, range: [number, number]): number[] {
  if (request.times) return [...request.times];
  const start = request.start ?? range[0];
  const end = request.end ?? range[1];
  if (!(end > start)) throw new Error("Contact sheet end must be later than start");
  if (request.interval !== undefined) {
    const times: number[] = [];
    for (let index = 0; start + index * request.interval < end; index++) {
      if (times.length >= MAX_CONTACT_SHEET_CELLS)
        throw new Error(
          `Contact sheet interval yields more than ${MAX_CONTACT_SHEET_CELLS} cells; widen the interval or narrow the range`,
        );
      times.push(roundTime(start + index * request.interval));
    }
    return times;
  }
  const count = request.count ?? 12;
  return Array.from({ length: count }, (_, index) =>
    roundTime(start + ((end - start) * index) / count),
  );
}

export function contactSheetLayout(request: ContactSheetRequest, cells: number, aspect: number) {
  const cellWidth = request.cellWidth ?? 320;
  const columns = Math.min(
    cells,
    request.columns ?? Math.ceil(Math.sqrt(cells * Math.max(0.25, Math.min(4, 1 / aspect)))),
    Math.max(1, Math.floor((MAX_SHEET_EDGE + GAP) / (cellWidth + GAP))),
  );
  const imageHeight = Math.max(1, Math.round(cellWidth * aspect));
  const rows = Math.ceil(cells / columns);
  const cellHeight = imageHeight + LABEL_HEIGHT;
  if (rows * (cellHeight + GAP) - GAP > MAX_SHEET_EDGE)
    throw new Error("Contact sheet would exceed 4096 px; reduce count or cellWidth");
  return { cellWidth, imageHeight, columns, rows, cellHeight };
}

export function formatSheetTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, "0")}`;
}

function roundTime(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
