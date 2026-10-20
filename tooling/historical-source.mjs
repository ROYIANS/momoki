import {readFileSync} from 'node:fs';
import {posix} from 'node:path';
import ts from 'typescript';

const policy = JSON.parse(readFileSync(new URL('../quality/studio-ownership.json', import.meta.url), 'utf8'));
const studioPrefix = 'packages/studio/src/';
const moduleName = file => '@/' + file.slice(studioPrefix.length).replace(/\.(?:tsx?|mts|mjs)$/, '');
const relocated = new Map(policy.files.filter(row => row.original?.startsWith(studioPrefix)).map(row => [moduleName(row.original), moduleName(row.file)]));

/** Adapt only module references in an explicitly delivered historical module. */
export function historicalSource(source, originalModule) {
    const original = originalModule.replace(/^packages\/studio\/src\//, '').replace(/^src\//, '');
    const parsed = ts.createSourceFile(original, source, ts.ScriptTarget.Latest, true, original.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const changes = [];
    const originalName = specifier => specifier.startsWith('.') ? '@/' + posix.normalize(posix.join(posix.dirname(original), specifier)) : specifier;
    const targetFor = specifier => {
        const name = originalName(specifier);
        return {name, split: policy.snapshotSplitModules[name], target: name === '@/lib/brand' ? '@momoki/distribution/brand' : relocated.get(name) ?? policy.snapshotSourceModules[name]};
    };
    const replaceSpecifier = node => {
        const {target} = targetFor(node.text);
        if (target && target !== node.text) changes.push([node.getStart(parsed), node.end, JSON.stringify(target)]);
    };
    function visit(node) {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const {split, target} = targetFor(node.moduleSpecifier.text);
            if (split) {
                const clause = node.importClause;
                if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) throw new Error('Historical split module needs explicit named imports: ' + node.moduleSpecifier.text);
                const groups = new Map();
                for (const element of clause.namedBindings.elements) {
                    const name = (element.propertyName ?? element.name).text;
                    if (!split[name]) throw new Error('Unmapped historical symbol ' + name + ' in ' + node.moduleSpecifier.text);
                    const names = groups.get(split[name]) ?? [];
                    names.push(element.getText(parsed));
                    groups.set(split[name], names);
                }
                const delivered = [...groups].map(([owner, names]) => `import ${clause.isTypeOnly ? 'type ' : ''}{${names.join(', ')}} from ${JSON.stringify(owner)};`).join('\n');
                changes.push([node.getStart(parsed), node.end, delivered]);
            } else if (target) replaceSpecifier(node.moduleSpecifier);
            return;
        }
        if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) replaceSpecifier(node.moduleSpecifier);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) replaceSpecifier(node.arguments[0]);
        ts.forEachChild(node, visit);
    }
    visit(parsed);
    for (const [start, end, text] of changes.sort((a, b) => b[0] - a[0])) source = source.slice(0, start) + text + source.slice(end);
    return source;
}
