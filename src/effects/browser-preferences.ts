export interface EffectBrowserPreferences {
  favorites: string[];
  recent: string[];
}

const STORAGE_KEY = "aster.effect-browser.preferences.v1";
const MAX_FAVORITES = 64;
const MAX_RECENT = 6;

const EMPTY_PREFERENCES: EffectBrowserPreferences = { favorites: [], recent: [] };

export function readEffectBrowserPreferences(
  storage: Pick<Storage, "getItem"> | undefined,
): EffectBrowserPreferences {
  if (!storage) return EMPTY_PREFERENCES;
  try {
    const parsed = JSON.parse(
      storage.getItem(STORAGE_KEY) ?? "null",
    ) as Partial<EffectBrowserPreferences>;
    return {
      favorites: stringList(parsed?.favorites, MAX_FAVORITES),
      recent: stringList(parsed?.recent, MAX_RECENT),
    };
  } catch {
    return EMPTY_PREFERENCES;
  }
}

export function writeEffectBrowserPreferences(
  storage: Pick<Storage, "setItem"> | undefined,
  preferences: EffectBrowserPreferences,
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Preference persistence must never interrupt editing or rendering.
  }
}

export function toggleFavoriteEffect(
  preferences: EffectBrowserPreferences,
  type: string,
): EffectBrowserPreferences {
  const favorites = preferences.favorites.includes(type)
    ? preferences.favorites.filter((entry) => entry !== type)
    : [type, ...preferences.favorites].slice(0, MAX_FAVORITES);
  return { ...preferences, favorites };
}

export function recordRecentEffect(
  preferences: EffectBrowserPreferences,
  type: string,
): EffectBrowserPreferences {
  return {
    ...preferences,
    recent: [type, ...preferences.recent.filter((entry) => entry !== type)].slice(0, MAX_RECENT),
  };
}

function stringList(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string"))].slice(
    0,
    maximum,
  );
}
