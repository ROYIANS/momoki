import {type Plugin} from "vite";
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {join, relative} from "node:path";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export const studioSource = join(repositoryRoot, "packages/studio/src");
export const sharedPublic = join(repositoryRoot, "packages/distribution/public");
export const appVersion = (JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {version: string}).version;

// Both independent builds report repository-relative module identities. Assembly
// verifies collisions before merging the two manifests and module reports.
export function chunkModuleReport(): Plugin {
    return {
        name: "momoki-chunk-module-report",
        apply: "build",
        generateBundle(_options, bundle) {
            const chunks: Record<string, string[]> = {};
            for (const [file, item] of Object.entries(bundle)) {
                if (item.type !== "chunk") continue;
                chunks[file] = item.moduleIds.filter(id => !id.startsWith("\0"))
                    .map(id => relative(repositoryRoot, id.split("?")[0]).replaceAll("\\", "/"));
            }
            this.emitFile({type: "asset", fileName: ".vite/chunk-modules.json", source: JSON.stringify(chunks)});
        },
    };
}

export function sitePublicFiles(): Plugin {
    return {
        name: "momoki-site-public",
        generateBundle() {
            const directory = join(repositoryRoot, "apps/site/public");
            for (const file of readdirSync(directory)) this.emitFile({type: "asset", fileName: file, source: readFileSync(join(directory, file))});
        },
    };
}
