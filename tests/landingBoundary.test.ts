import {readdirSync, readFileSync} from "node:fs";
import {dirname, join, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const sourceRoot = fileURLToPath(new URL("../packages/studio/src", import.meta.url));
const landingRoot = fileURLToPath(new URL("../apps/site/src", import.meta.url));
const distributionRoot = fileURLToPath(new URL("../packages/distribution/src", import.meta.url));
// The only application modules the standalone entry may use: dependency-free ones.
const APP_ALLOWED = new Set(["@momoki/distribution/analytics", "@momoki/distribution/brand", "@momoki/distribution/releases", "@momoki/distribution/platform"]);
const PACKAGE_ALLOWED = /^(react|react-dom|react\/jsx-runtime|react-dom\/client|motion|motion\/.+)$/;

function listFiles(directory: string): string[] {
    return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? listFiles(path) : [path];
    });
}

function specifiers(source: string): string[] {
    const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
    return [...source.matchAll(pattern)].map(match => match[1]);
}

function isAllowed(specifier: string): boolean {
    if (specifier.startsWith(".")) return true;
    if (specifier.startsWith("@momoki/")) return APP_ALLOWED.has(specifier);
    return PACKAGE_ALLOWED.test(specifier);
}

describe("landing source boundary", () => {
    it("imports only relative modules, React, motion and the dependency-free umami/brand modules", () => {
        const files = listFiles(landingRoot).filter(file => /\.(tsx?|css)$/.test(file));
        expect(files.length).toBeGreaterThan(0);
        const bad = files.flatMap(file => specifiers(readFileSync(file, "utf8")).filter(item => !isAllowed(item)).map(item => `${file.replace(sourceRoot, "src")}: ${item}`));
        expect(bad).toEqual([]);
    });

    it("rejects application, storage, router, Tauri and UI-library imports", () => {
        const rejected = ["@/platform/product/store", "@/platform/product/queries", "@/components/ui/button", "@/styles.css", "dexie", "zod",
            "@tanstack/react-router", "@tauri-apps/api/core", "antd", "@lobehub/ui", "../main", "@/main"];
        expect(rejected.filter(isAllowed)).toEqual(["../main"]); // relative paths are checked by the real-file scan above
        expect(specifiers(`import {a} from "dexie"; import("zod"); import "@/db/x"; export * from "antd";`)).toEqual(["dexie", "zod", "@/db/x", "antd"]);
    });

    it("keeps the shared modules dependency-free", () => {
        for (const file of ["analytics.ts", "brand.ts"]) expect(specifiers(readFileSync(join(distributionRoot, file), "utf8")), file).toEqual([]);
    });

    // The modules the standalone entry actually reaches must stay dependency-free.
    // Siblings in the same folder (download.ts) are desktop-settings-only and are
    // excluded by the allowlist above, so the landing closure cannot grow silently.
    it("keeps the landing-reachable shared release modules free of application, storage, router and Tauri imports", () => {
        const reachable = ["releases.ts", "platform.ts", "version.ts"];
        const allowed = (item: string) => item.startsWith("./") || item === "@momoki/distribution/brand";
        const bad = reachable.flatMap(name => {
            const file = join(distributionRoot, name);
            return specifiers(readFileSync(file, "utf8")).filter(item => !allowed(item)).map(item => `lib/desktopRelease/${name}: ${item}`);
        });
        expect(bad).toEqual([]);
        expect(specifiers(readFileSync(join(sourceRoot, "platform/media/sha256.ts"), "utf8"))).toEqual([]);
    });

    it("never lets the landing entry reach the settings-only download helper", () => {
        const files = listFiles(landingRoot).filter(file => /\.tsx?$/.test(file));
        const bad = files.flatMap(file => specifiers(readFileSync(file, "utf8")).filter(item => item.includes("desktopRelease/download") || item.includes("@momoki/studio")).map(item => `${file}: ${item}`));
        expect(bad).toEqual([]);
        expect(APP_ALLOWED.has("@/lib/desktopRelease/download")).toBe(false);
    });

    it("keeps relative imports inside packages/studio/src/landing", () => {
        const escaping = listFiles(landingRoot).filter(file => /\.tsx?$/.test(file)).flatMap(file =>
            specifiers(readFileSync(file, "utf8")).filter(item => item.startsWith(".")).filter(item => {
                const target = resolve(dirname(file), item);
                return target !== landingRoot && !target.startsWith(landingRoot + sep);
            }).map(item => `${file}: ${item}`));
        expect(escaping).toEqual([]);
    });
});
