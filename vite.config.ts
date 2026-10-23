import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { configDefaults } from "vitest/config";
import { appVersion } from "./scripts/electron-builder";

const DISABLED_BUNDLED_DEV_VALUES = new Set(["0", "false", "no", "off"]);
const ENABLED_BUNDLED_DEV_VALUES = new Set(["1", "true", "yes", "on"]);

export function rendererBoundary(reference: boolean): Plugin {
  return {
    name: "aster-renderer-boundary",
    generateBundle(_options, bundle) {
      const retained = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const id of Object.keys(output.modules)) {
          const path = id.replaceAll("\\", "/");
          for (const source of [
            "src/renderer/webgpu-renderer.ts",
            "src/renderer/compositing/beauty-frame.ts",
            "src/components/render-host/RenderHost.tsx",
          ])
            if (path.endsWith(`/${source}`)) retained.add(source);
        }
      }
      if (!reference && retained.size)
        this.error(`TS renderer entered production: ${[...retained].join(", ")}`);
      if (reference && !retained.has("src/renderer/webgpu-renderer.ts"))
        this.error("Reference renderer is absent from its explicit bundle");
      this.emitFile({
        type: "asset",
        fileName: "renderer-boundary.json",
        source: JSON.stringify({
          schema_version: 1,
          reference,
          retained_modules: [...retained].sort(),
        }),
      });
    },
  };
}

export function resolveBundledDev(
  command: "build" | "serve",
  mode: string,
  configuredValue?: string,
): boolean {
  if (command !== "serve" || mode !== "development") return false;

  const normalizedValue = configuredValue?.trim().toLowerCase();
  if (!normalizedValue || ENABLED_BUNDLED_DEV_VALUES.has(normalizedValue)) return true;
  if (DISABLED_BUNDLED_DEV_VALUES.has(normalizedValue)) return false;

  throw new Error(
    `ASTER_BUNDLED_DEV must be one of ${[
      ...ENABLED_BUNDLED_DEV_VALUES,
      ...DISABLED_BUNDLED_DEV_VALUES,
    ].join(", ")}; received ${JSON.stringify(configuredValue)}`,
  );
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, process.cwd(), "ASTER_");

  return {
    base: "./",
    plugins: [react(), rendererBoundary(mode === "reference")],
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __ASTER_TS_REFERENCE__: mode === "reference",
    },

    // Aster's editor has a broad, GPU-oriented module graph. Vite's request-by-request transform
    // waterfall made a cold Electron window wait tens of seconds before React could mount, while
    // Rolldown bundles the same graph in under a second. Full-bundle dev keeps HMR while avoiding
    // that waterfall. Set ASTER_BUNDLED_DEV=0 to temporarily use Vite's traditional dev server.
    experimental: {
      bundledDev: resolveBundledDev(command, mode, environment.ASTER_BUNDLED_DEV),
    },

    build:
      command === "build"
        ? {
            outDir: mode === "reference" ? "dist-reference" : "dist",
            rolldownOptions: {
              output: {
                codeSplitting: {
                  groups: [
                    {
                      name: "react-runtime",
                      test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
                      priority: 30,
                    },
                    {
                      name: "icon-library",
                      test: /node_modules[\\/]lucide-react[\\/]/,
                      priority: 20,
                    },
                    {
                      name: "effect-catalog",
                      test: /src[\\/](?:effects|renderer[\\/]effects[\\/]shaders[\\/]effect-shader-cases)\b/,
                      priority: 10,
                      includeDependenciesRecursively: false,
                    },
                    {
                      name: "gpu-runtime",
                      // Keep eager shader catalog inputs in the same chunk as its constructor.
                      // Otherwise the application chunk's cyclic import exposes uninitialized JSON.
                      test: /(?:src[\\/]renderer|shaders)[\\/]/,
                      priority: 5,
                      includeDependenciesRecursively: false,
                    },
                  ],
                },
              },
            },
          }
        : undefined,

    // Keep Electron's development URL stable so navigation policy and HMR remain deterministic.
    clearScreen: false,
    test: {
      exclude: [
        ...configDefaults.exclude,
        ".aster-cache/**",
        ".pnpm-store/**",
        "scripts/**/*.test.mjs",
        "artifacts/**",
        "artifacts-final/**",
      ],
    },
    server: {
      port: 1420,
      strictPort: true,
      host: "127.0.0.1",
      watch: {
        ignored: ["**/crates/aster-desktop-bridge/**", "**/dist-electron/**"],
      },
    },
  };
});
