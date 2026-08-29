import { describe, expect, it } from "vitest";
import { findMenuEntry, menuDefinitions } from "./topbar-menu";

describe("layer creation menu", () => {
  it("exposes first-class null and solid layer commands", () => {
    const layerMenu = menuDefinitions.find((menu) => menu.id === "layer");
    expect(layerMenu?.items.map((item) => item.id)).toEqual(
      expect.arrayContaining(["newNull", "newSolid"]),
    );
    expect(findMenuEntry("newNull")?.labelKey).toBe("topbar.item.newNull");
    expect(findMenuEntry("newSolid")?.labelKey).toBe("topbar.item.newSolid");
  });
});
