import { describe, expect, it } from "vitest";
import {
  readEffectBrowserPreferences,
  recordRecentEffect,
  toggleFavoriteEffect,
  writeEffectBrowserPreferences,
} from "./browser-preferences";

describe("effect browser preferences", () => {
  it("sanitizes malformed persisted values", () => {
    const storage = {
      getItem: () => JSON.stringify({ favorites: ["exposure", 4, "exposure"], recent: null }),
    };
    expect(readEffectBrowserPreferences(storage)).toEqual({ favorites: ["exposure"], recent: [] });
    expect(readEffectBrowserPreferences({ getItem: () => "{" })).toEqual({
      favorites: [],
      recent: [],
    });
  });

  it("toggles favorites and keeps recent effects unique", () => {
    const initial = { favorites: [], recent: ["glow", "exposure"] };
    const favorite = toggleFavoriteEffect(initial, "glow");
    expect(favorite.favorites).toEqual(["glow"]);
    expect(toggleFavoriteEffect(favorite, "glow").favorites).toEqual([]);
    expect(recordRecentEffect(initial, "exposure").recent).toEqual(["exposure", "glow"]);
  });

  it("tolerates unavailable preference storage", () => {
    expect(() =>
      writeEffectBrowserPreferences(
        {
          setItem: () => {
            throw new Error("disabled");
          },
        },
        { favorites: ["glow"], recent: [] },
      ),
    ).not.toThrow();
  });
});
