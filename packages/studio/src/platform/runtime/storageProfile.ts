import {isTauriRuntime} from "./runtimeIdentity";

export type ProductStorageOwner = "indexeddb" | "sqlite";

type ProductStorage = Readonly<{
    runtime: "browser" | "tauri";
    storage: ProductStorageOwner;
    profileId: string | null;
    databaseName: string;
}>;

declare global {
    interface Window {
        /** Installed by the trusted native initialization script before product modules load. */
        __MOMOKI_PRODUCT_PROFILE__?: unknown;
    }
}

/** Resolve declared startup identity; never infer the product database from Tauri presence. */
export function resolveProductStorage(native: boolean, profile: unknown): ProductStorage {
    if (!native) return Object.freeze({
        runtime: "browser", storage: "indexeddb", profileId: null, databaseName: "aifenjing",
    });
    if (!profile || typeof profile !== "object" || Array.isArray(profile) ||
        !("version" in profile) || profile.version !== 1 ||
        !("id" in profile) || typeof profile.id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(profile.id) ||
        !("storage" in profile) || (profile.storage !== "indexeddb" && profile.storage !== "sqlite") ||
        Object.keys(profile).some(key => !["version", "id", "storage"].includes(key))) {
        throw new Error("桌面应用的存储配置无效，请重新打开应用");
    }
    return Object.freeze({
        runtime: "tauri", storage: profile.storage, profileId: profile.id,
        databaseName: `momoki-desktop:${profile.id}:v1`,
    });
}

// One fixed owner per loaded product. No preference, query string or failed-write fallback can switch it.
const productStorage = resolveProductStorage(
    isTauriRuntime(),
    typeof window === "undefined" ? undefined : window.__MOMOKI_PRODUCT_PROFILE__,
);

export function getProductStorage(): ProductStorage {
    return productStorage;
}

export function usesSqliteProductStorage(): boolean {
    return productStorage.storage === "sqlite";
}
