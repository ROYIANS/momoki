import {fileURLToPath, URL} from "node:url";
import {dirname, resolve} from "node:path";
import {createRequire} from "node:module";
import type {Alias} from "vite";
import {defineConfig} from "vitest/config";
import {snapshotOwner, snapshotModule} from "./snapshot-owners.ts";

/** Shared fixture configuration; callers choose artifact or explicit source resolution. */
export function createStudioVitestConfig(options: {aliases?: Alias[]; include?: string[]} = {}) {
  const studioRequire = createRequire(new URL("../packages/studio/package.json", import.meta.url));
  const integrationDependencies = ["@dnd-kit/core", "@dnd-kit/sortable", "@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/plugin-http"];

  return defineConfig({
  plugins: [{
    name: "d05-original-material-export-compatibility",
    enforce: "pre",
    load: snapshotModule,
    resolveId(source, importer) {
      const historical = snapshotOwner(source, importer);
      if (historical) return historical;
      const target=source.startsWith(".") && importer ? resolve(dirname(importer),source) : source;
      if (!source.includes("?fixture-original") && (source === "@/platform/storage/store" || target === fileURLToPath(new URL("../packages/studio/src/platform/storage/store", import.meta.url)) || target === fileURLToPath(new URL("../packages/studio/src/platform/storage/store.ts", import.meta.url)))) {
        return fileURLToPath(new URL("../tests/fixtures/shared-storage/storeFactory.ts", import.meta.url));
      }
      if (process.env.MOMOKI_TOOL_COVERAGE_DIR && !source.includes("?coverage-original") && (source === "@/features/agent/runtime/toolDefinition" || target === fileURLToPath(new URL("../packages/studio/src/features/agent/runtime/toolDefinition", import.meta.url)) || target === fileURLToPath(new URL("../packages/studio/src/features/agent/runtime/toolDefinition.ts", import.meta.url)))) {
        return fileURLToPath(new URL("../tests/fixtures/shared-storage/toolDefinitionCoverage.ts", import.meta.url));
      }
      if (process.env.MOMOKI_STORAGE_TEST_OWNER === "sqlite" && (source === "@/platform/product/store" || target === fileURLToPath(new URL("../packages/studio/src/platform/product/store", import.meta.url)) || target === fileURLToPath(new URL("../packages/studio/src/platform/product/store.ts", import.meta.url)))) {
        return fileURLToPath(new URL("../tests/fixtures/shared-storage/nativeDatabase.ts", import.meta.url));
      }
      if ((source === "@/db/materials" || source === fileURLToPath(new URL("../packages/studio/src/db/materials", import.meta.url))) && importer?.replaceAll("\\", "/").endsWith("/tests/fixtures/sourceSnapshots/d05/src/lib/agent/materialTools.ts")) {
        return fileURLToPath(new URL("../tests/fixtures/e07/original-materials-adapter.ts", import.meta.url));
      }
    },
  }],
  resolve: {
    alias: [
      ...(options.aliases ?? []),
      ...integrationDependencies.map(name => ({find: name, replacement: studioRequire.resolve(name)})),
      {find: "@", replacement: fileURLToPath(new URL("../packages/studio/src", import.meta.url))},
    ],
  },
  test: {
    include: options.include ?? ["tests/**/*.test.ts", "packages/studio/src/features/**/*.test.ts", "packages/agent-*/src/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    clearMocks: true,
    ...(process.env.MOMOKI_STORAGE_TEST_OWNER === "sqlite" ? {maxWorkers:2,testTimeout:20000,hookTimeout:20000} : {}),
  },
  });
}
