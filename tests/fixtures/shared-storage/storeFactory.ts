import {createProductStore as originalCreateProductStore} from "../../../packages/studio/src/platform/storage/store?fixture-original";
import type {ProductStore,StoreDriver} from "@/platform/storage/types";
import {appendFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {expect} from "vitest";

export * from "../../../packages/studio/src/platform/storage/store?fixture-original";

const drivers=new WeakMap<ProductStore,StoreDriver>();
/** Tests retain the exact production factory and adapters, exposing only their owner. */
export function createProductStore(driver:StoreDriver):ProductStore {
    const store=originalCreateProductStore(driver);
    drivers.set(store,driver);
    const directory=process.env.MOMOKI_TOOL_COVERAGE_DIR;
    if (directory) {
        mkdirSync(directory,{recursive:true});
        store.subscribe(change=>appendFileSync(join(directory,`tables-${process.pid}-${process.env.VITEST_POOL_ID ?? "worker"}.jsonl`),JSON.stringify({kind:"committedTables",owner:driver.owner,tables:[...change.tables],test:expect.getState().currentTestName ?? "unknown",file:expect.getState().testPath ?? "unknown"})+"\n"));
    }
    return store;
}
export function getFixtureStoreDriver(store:ProductStore):StoreDriver|undefined {return drivers.get(store);}
