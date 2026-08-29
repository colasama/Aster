import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { developmentProfileDirectory } from "./profile-paths";

describe("desktop profile paths", () => {
  it("isolates an unpackaged checkout from the installed application profile", () => {
    expect(developmentProfileDirectory("C:\\Users\\dev\\AppData\\Roaming", false, false)).toBe(
      join("C:\\Users\\dev\\AppData\\Roaming", "Aster Development"),
    );
  });

  it("keeps the platform profile for packaged builds", () => {
    expect(developmentProfileDirectory("ignored", true, false)).toBeUndefined();
  });

  it("preserves an explicit user-data-dir override", () => {
    expect(developmentProfileDirectory("ignored", false, true)).toBeUndefined();
  });
});
