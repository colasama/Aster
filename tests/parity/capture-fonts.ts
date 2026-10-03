import type { ParityCaptureApi } from "./capture-protocol";

export type CaptureFontFingerprint =
  | { status: "available"; sha256: string; count: number }
  | { status: "unavailable"; reason: string };

export interface CaptureLocalFont {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob(): Promise<Blob>;
}

export type CaptureFontQuery = () => Promise<readonly CaptureLocalFont[]>;

/** Only aggregate identity leaves the renderer; font names and bytes stay local. */
export async function captureFontFingerprint(
  query?: CaptureFontQuery,
): Promise<CaptureFontFingerprint> {
  const browser =
    typeof window === "undefined"
      ? undefined
      : (window as Window & { queryLocalFonts?: CaptureFontQuery });
  const read = query ?? browser?.queryLocalFonts?.bind(browser);
  if (!read) return { status: "unavailable", reason: "Local Font Access API is unavailable" };
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return { status: "unavailable", reason: "Font SHA-256 is unavailable" };
  let stage = "Local font inventory query failed";
  try {
    const fonts = await read();
    if (!Array.isArray(fonts) || fonts.length === 0)
      return { status: "unavailable", reason: "Local font inventory is empty or invalid" };
    const records: string[] = [];
    for (const font of fonts) {
      stage = "Local font metadata is invalid";
      const metadata = [font.family, font.fullName, font.postscriptName, font.style];
      if (metadata.some((value) => typeof value !== "string")) throw new Error(stage);
      stage = "Local font payload could not be read";
      const bytes = await (await font.blob()).arrayBuffer();
      if (bytes.byteLength === 0) throw new Error(stage);
      stage = "Font SHA-256 computation failed";
      const hash = await subtle.digest("SHA-256", bytes);
      const sha256 = [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      records.push(JSON.stringify([...metadata, sha256]));
    }
    // Code-point order is independent of the host locale and the enumeration order.
    const aggregate = new TextEncoder().encode(
      JSON.stringify({ version: 1, fonts: records.sort() }),
    );
    const hash = await subtle.digest("SHA-256", aggregate);
    return {
      status: "available",
      sha256: [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      count: records.length,
    };
  } catch {
    return { status: "unavailable", reason: stage };
  }
}

export function withCaptureFontRecheck(
  api: ParityCaptureApi,
  initial: CaptureFontFingerprint,
  read: () => Promise<CaptureFontFingerprint> = captureFontFingerprint,
): ParityCaptureApi {
  return {
    ...api,
    async done() {
      const final = await read();
      const changed =
        initial.status !== final.status ||
        (initial.status === "available" &&
          final.status === "available" &&
          (initial.sha256 !== final.sha256 || initial.count !== final.count));
      if (changed)
        await api.fail({
          error:
            "System font inputs changed during reference capture; references cannot be published",
        });
      await api.done();
    },
  };
}
