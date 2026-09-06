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
