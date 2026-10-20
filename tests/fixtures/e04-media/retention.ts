import Dexie from "dexie";
import {db} from "@/platform/product/store";
import {deleteMediaIfOrphan, deleteMediaIfOrphans, collectMediaIds} from "@/features/library/commands/media";
import {PRODUCTION_TABLES} from "@/platform/product/scopes";
import {deleteMediaIfOrphan as originalDelete} from "../sourceSnapshots/e04-media/src/db/media";
import {check, media, retentionSources, historySources, currentSources, type RetentionSource} from "./seeds";
import {observe} from "./instrumentation";
import {interceptStoreTable} from "../../helpers/storeFaults";

export async function isolatedSource(source: RetentionSource) {
    const id = `candidate-${source.name}`, owner = "media-owner";
    await db.media.put(media(id, owner));
    const remove = await source.put(id, source.history ? owner : "foreign-owner");
    await deleteMediaIfOrphans([id, id, undefined, "", "missing"]);
    check(!!await db.media.get(id) === source.retains, `${source.name}: isolated retention`);
    if (source.retains) {
        await remove(); await deleteMediaIfOrphan(id);
        check(!await db.media.get(id), `${source.name}: last reference collection`);
    }
    return {source: source.name, retained: source.retains, lastReferenceCollected: source.retains};
}
export async function mixedOwnerParity() {
    const owners = ["project-A", "project-B", "studio"], ids: string[] = [];
    for (const owner of owners) for (const [index, source] of historySources.entries()) {
        const same = `${owner}-${index}-same`, foreign = `${owner}-${index}-foreign`;
        ids.push(same, foreign); await db.media.bulkPut([media(same, owner), media(foreign, owner)]);
        await source.put(same, owner); await source.put(foreign, `foreign-${owner}`);
    }
    const globalId = "global-foreign-current"; ids.push(globalId);
    await db.media.put(media(globalId, "studio")); await currentSources.find(s => s.name === "unplaced audio take")!.put(globalId, "foreign-owner");
    const records = await db.media.toArray();
    for (const id of ids) await originalDelete(id);
    const before = (await db.media.toArray()).map(row => row.id);
    await db.media.bulkPut(records);
    await deleteMediaIfOrphans([...ids, ...ids, "missing", undefined]);
    const after = (await db.media.toArray()).map(row => row.id);
    check(JSON.stringify(after) === JSON.stringify(before), "mixed owner original/current parity");
    check(after.length === owners.length * historySources.length + 1, "foreign history must not retain; global current must retain");
    const scoped = await collectMediaIds("studio");
    check(!scoped.has(globalId) && !scoped.has("studio-0-same"), "backup projection excludes foreign-current and histories");
    check((await collectMediaIds()).has(globalId), "global backup/current includes foreign current");
    return {owners, candidates: ids.length, kept: after.length, parity: true, backupProjection: true};
}
export async function snapshotFreshness(source: RetentionSource) {
    const owner = "fresh-owner", first = "first-orphan", second = "second-later-retained";
    await db.media.bulkPut([media(first, owner), media(second, owner)]);
    await db.transaction("rw", PRODUCTION_TABLES, async (db) => {
        await deleteMediaIfOrphans([first], db); check(!await db.media.get(first), "first mutation must happen");
        const remove = await source.put(second, owner, db);
        await deleteMediaIfOrphans([second], db); check(await db.media.get(second), `${source.name}: later addition visible`);
        await remove(); await deleteMediaIfOrphans([second], db); check(!await db.media.get(second), `${source.name}: later removal visible`);
    });
    return {source: source.name, freshAdditionAndRemoval: true};
}
/** E04's 14 current-reference passes plus the two full media passes added by the desktop media commit (2b00d8e5):
 * the candidate dependency-closure read in deleteMediaIfOrphans and the dependency expansion in collectMediaIds.
 * Both are one bounded scan each, independent of candidate count; thread-activity (E11) rows live in deviceSettings and are never scanned here. */
// One more global reference scan than before: IP portraits (`ipProfiles.avatarMediaId`).
export const CURRENT_REFERENCE_PASSES = 15 + 2;
export async function workCount(size: number, original = false, ownerCount = 3) {
    const owners = Array.from({length: ownerCount}, (_, i) => `owner-${i}`), ids: string[] = [];
    for (let i = 0; i < size; i++) {const id = `work-${i}`; ids.push(id); await db.media.put(media(id, owners[i % owners.length], true));}
    // Add unrelated history rows: indexed owner reads must not visit them.
    for (const source of historySources) await source.put(`unrelated-${source.name}`, "unrelated-owner");
    const observed = await observe(async () => {
        if (original) for (const id of [...ids, ...ids]) await originalDelete(id);
        else await deleteMediaIfOrphans([...ids, ...ids, undefined, "missing"]);
    });
    const scans = observed.scans.filter(scan => scan.method === "query" || scan.method === "cursor");
    const actualOwners = new Set(ids.map((_, i) => owners[i % owners.length])).size;
    const batchReferenceScans = scans.filter(scan => scan.table === "audioGenerationBatchItems");
    check(batchReferenceScans.length === (original ? 0 : 1), "one additive v24 batch reference scan, independent of candidates/owners");
    if (!original) check(batchReferenceScans[0].index == null && batchReferenceScans[0].rangeType === 3, "batch references scanned once globally like existing current references");
    const expectedPasses = original ? 18 * size * 2 : CURRENT_REFERENCE_PASSES + 1 + 4 * actualOwners;
    check(scans.length === expectedPasses, `work passes: expected ${expectedPasses}, actual ${scans.length}`);
    const mediaReads = observed.scans.filter(scan => scan.table === "media" && ["getMany", "get"].includes(scan.method));
    // Since 2b00d8e5 candidates are resolved by one whole-table media pass (dependency closure) instead of one
    // deduplicated bulk id read: no per-candidate reads may appear, and media passes stay a fixed three
    // (closure read, retained-flag read, dependency expansion) regardless of candidate count.
    if (!original) {
        check(mediaReads.length === 0, "no per-candidate media reads (duplicates/missing ids deduplicated)");
        check(scans.filter(scan => scan.table === "media").length === 3, "fixed media passes independent of candidate count");
    }
    const stores = [...new Set(observed.scans.flatMap(scan => scan.stores))].sort();
    check(JSON.stringify(stores) === JSON.stringify(PRODUCTION_TABLES.map(t => t.name).sort()), "complete current production scope");
    check(scans.filter(s => s.table.startsWith("agentGeneration") || s.table === "productionProposals").every(s => s.rows === 0), "unrelated history rows excluded");
    return {size, actualOwners, original, passes: scans.length, batchReferencePasses: batchReferenceScans.length, rows: scans.reduce((n, s) => n + s.rows, 0), mediaReads, scans, stores, limitation: "Request/cursor work counts; elapsed latency is not inferred"};
}
export async function nativeScheduling() {
    const ids = Array.from({length: 24}, (_, i) => `schedule-${i}`);
    await db.media.bulkPut(ids.map(id => media(id, "schedule-owner")));
    const events: string[] = [];
    let competing: Promise<void> | undefined, originalRoot: IDBTransaction | undefined;
    const fault = interceptStoreTable(db, "media", "delete", async (tx, args, next) => {
        if (!competing) {
            originalRoot = Dexie.currentTransaction!.idbtrans;
            await next(); events.push("first-real-delete");
            // Explicitly leave the raw browser context to enqueue an overlapping
            // writer. Each business read still receives its own explicit store.
            competing = Dexie.ignoreTransaction(() => db.transaction("rw", PRODUCTION_TABLES, async (db) => {
                events.push("competing-start");
                check(!await db.media.get(ids[0]), "overlapping writer ran before cleanup commit");
                check((await db.media.bulkGet(ids)).every(row => row === undefined), "partial batch escaped");
            }));
            check(!await tx.media.get(String(args[0])), "first delete is visible in its explicit transaction");
            return;
        }
        check(Dexie.currentTransaction!.idbtrans === originalRoot, "batch escaped original native transaction");
        return next();
    });
    try {await deleteMediaIfOrphans(ids); events.push("cleanup-resolved"); await competing;}
    finally {fault.mockRestore();}
    check(events[0] === "first-real-delete" && events.includes("competing-start"), "scheduling seam reached");
    return {events, candidates: ids.length, sameNativeTransaction: true, overlappingWriterSawWholeCommit: true};
}
export {retentionSources};
