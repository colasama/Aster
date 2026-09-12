export interface ViewerGuide {
  id: string;
  axis: "x" | "y";
  position: number;
}

export function parseViewerGuides(value: string | null): ViewerGuide[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const ids = new Set<string>();
    return parsed
      .filter((guide): guide is ViewerGuide => {
        if (
          !guide ||
          typeof guide !== "object" ||
          typeof guide.id !== "string" ||
          guide.id.length > 100 ||
          ids.has(guide.id) ||
          (guide.axis !== "x" && guide.axis !== "y") ||
          !Number.isFinite(guide.position) ||
          guide.position < 0 ||
          guide.position > 100_000
        )
          return false;
        ids.add(guide.id);
        return true;
      })
      .slice(0, 128)
      .map(({ id, axis, position }) => ({ id, axis, position }));
  } catch {
    return [];
  }
}

export function rulerTicks(length: number, zoom: number): number[] {
  if (length <= 0 || zoom <= 0 || !Number.isFinite(length * zoom)) return [];
  const desired = 70 / zoom;
  const power = 10 ** Math.floor(Math.log10(desired));
  const step = [1, 2, 5, 10].map((n) => n * power).find((n) => n >= desired) ?? power * 10;
  return Array.from({ length: Math.min(512, Math.floor(length / step) + 1) }, (_, i) => i * step);
}
