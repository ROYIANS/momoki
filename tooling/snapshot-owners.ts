import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import ts from 'typescript';
const root = fileURLToPath(new URL('../', import.meta.url));
const studio = join(root, 'packages/studio/src');
const policy = JSON.parse(readFileSync(join(root, 'quality/studio-ownership.json'), 'utf8')) as {snapshotSplitModules: Record<string, Record<string, string>>; snapshotSourceModules: Record<string, string>};
const virtualPrefix = '\0snapshot-owner:';
const actual = (target: string): string => {
    if (target.startsWith('@momoki/')) return fileURLToPath(import.meta.resolve(target));
    const path = join(studio, target.slice(2));
    return [path, path + '.ts', path + '.tsx', path + '.mjs'].find(existsSync) ?? path;
};
/** Only immutable comparator modules may resolve their historical external owners. */
export function snapshotOwner(source: string, importer?: string): string | undefined {
    if (source.startsWith(virtualPrefix)) return source;
    const caller = importer?.replaceAll('\\', '/');
    if (!caller || !(caller.includes('/tests/fixtures/sourceSnapshots/') || caller.endsWith('/tests/fixtures/workspace/originalProductionRevision.ts'))) return;
    const normalized = source.startsWith(studio + '/') ? '@/' + source.slice(studio.length + 1) : source;
    if (normalized === '@/lib/brand') return join(root, 'packages/distribution/src/brand.ts');
    if (normalized === '@/db/database') return join(root, 'tests/fixtures/shared-storage/rawBrowserDatabase.ts');
    if (normalized === '@/db/materials' && caller.endsWith('/sourceSnapshots/d05/src/lib/agent/materialTools.ts')) return join(root, 'tests/fixtures/e07/original-materials-adapter.ts');
    if (normalized === '@/db/productionShared' && caller.endsWith('/sourceSnapshots/e04-media/src/db/productionShared.ts')) return virtualPrefix + 'e04-media-productionShared';
    if (policy.snapshotSplitModules[normalized]) return virtualPrefix + normalized;
    if (policy.snapshotSourceModules[normalized]) return actual(policy.snapshotSourceModules[normalized]);
}
export function snapshotModule(id: string): string | undefined {
    if (!id.startsWith(virtualPrefix)) return;
    const source = id.slice(virtualPrefix.length);
    if (source === 'e04-media-productionShared') {
        const entries = policy.snapshotSplitModules['@/db/productionShared'];
        return `import {db} from ${JSON.stringify(join(root, 'tests/fixtures/shared-storage/rawBrowserDatabase.ts'))};\nimport {PRODUCTION_TABLES as scope} from ${JSON.stringify(actual(entries.PRODUCTION_TABLES))};\nexport const PRODUCTION_TABLES = scope.map(table => db.table(table.name));\n` + Object.entries(entries).filter(([name]) => name !== 'PRODUCTION_TABLES').map(([name, target]) => `export {${name}} from ${JSON.stringify(actual(target))};`).join('\n');
    }
    return Object.entries(policy.snapshotSplitModules[source]).filter(([name, target]) => {
        const file = actual(target);
        const parsed = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        return parsed.statements.some(statement => {
            // Named split entries may now point at emitted public package barrels.
            // Preserve the explicit value/type distinction when following those exports.
            if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) return statement.exportClause.elements.some(element => !element.isTypeOnly && element.name.text === name);
            if (!(ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))) return false;
            if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) return statement.name?.text === name;
            return ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name);
        });
    }).map(([name, target]) => `export {${name}} from ${JSON.stringify(actual(target))};`).join('\n');
}
