export interface SystemFont {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
}

export interface DesktopFonts {
  list(): Promise<SystemFont[]>;
}

export async function listSystemFonts(): Promise<SystemFont[]> {
  if (window.asterDesktop?.fonts) return window.asterDesktop.fonts.list();
  const browser = window as Window & { queryLocalFonts?: () => Promise<SystemFont[]> };
  if (!browser.queryLocalFonts)
    throw new Error(
      "System font inventory requires the Aster desktop app or Local Font Access API",
    );
  return browser.queryLocalFonts();
}

let familyInventory: { expires: number; families: Promise<string[]> } | undefined;

/** Unique installed family names, cached briefly so pickers can reopen without a rescan. */
export function listSystemFontFamilies(): Promise<string[]> {
  if (!familyInventory || familyInventory.expires < Date.now()) {
    const families = listSystemFonts().then((fonts) => [
      ...new Set(fonts.map((font) => font.family)),
    ]);
    familyInventory = { expires: Date.now() + 60_000, families };
    void families.catch(() => {
      familyInventory = undefined;
    });
  }
  return familyInventory.families;
}
