import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PluginRegistryCatalog } from "../core/plugin-catalog";
import { PluginRegistryPreview } from "./PluginRegistryPreview";

const catalog: PluginRegistryCatalog = {
  source: "Built-in development fixture",
  developmentFixture: true,
  hostApiVersion: 1,
  packages: [
    {
      id: "org.aster.tint",
      name: "Soft Tint",
      summary: "GPU color treatment",
      author: "Aster",
      latestVersion: "2.0.0",
      apiVersion: 1,
      compatible: true,
      compatibleVersion: "1.1.0",
      capabilities: ["gpu_render"],
    },
    {
      id: "org.example.future",
      name: "Future Effect",
      summary: "Future API example",
      author: "Example",
      latestVersion: "2.0.0",
      apiVersion: 2,
      compatible: false,
      compatibleVersion: null,
      capabilities: ["network"],
    },
  ],
};

describe("PluginRegistryPreview", () => {
  it("labels the fixture, compatibility, and manual-only install boundary", () => {
    const markup = renderToStaticMarkup(<PluginRegistryPreview catalog={catalog} query="" />);
    expect(markup).toContain("Development fixture");
    expect(markup).toContain("No network request");
    expect(markup).toContain("Host compatible");
    expect(markup).toContain("Requires API 2");
    expect(markup.match(/Manual folder/g)).toHaveLength(2);
    expect(markup).not.toContain("download_url");
    expect(markup).not.toContain("sha256");
  });

  it("filters before rendering catalog entries", () => {
    const markup = renderToStaticMarkup(
      <PluginRegistryPreview catalog={catalog} query="gpu_render" />,
    );
    expect(markup).toContain("Soft Tint");
    expect(markup).not.toContain("Future Effect");
    expect(markup).toContain("1 shown");
  });

  it("does not make development-only network claims for a future catalog", () => {
    const markup = renderToStaticMarkup(
      <PluginRegistryPreview catalog={{ ...catalog, developmentFixture: false }} query="" />,
    );
    expect(markup).toContain("Registry catalog");
    expect(markup).toContain("does not install or execute plugins");
    expect(markup).not.toContain("No network request");
  });
});
