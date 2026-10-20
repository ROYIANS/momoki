import type {LatestDesktopRelease, ReleaseAsset} from "./releases";

// Visitor platform detection and installer selection. Pure: the caller passes
// the navigator values, so nothing here reads a global. Shared by the standalone
// landing entry and the desktop settings update check.

type OsName = "macos" | "windows" | "linux" | "ios" | "android" | "unknown";
type ArchName = "arm64" | "x64" | "unknown";
export type DetectedPlatform = { os: OsName; arch: ArchName; mobile: boolean };

export type NavigatorInfo = {
    userAgent: string;
    platform?: string;
    maxTouchPoints?: number;
    userAgentData?: {
        platform?: string;
        mobile?: boolean;
        getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
    };
};

function osOf(text: string | undefined): OsName | undefined {
    if (!text) return undefined;
    const value = text.toLowerCase();
    if (/cros|chrome os/.test(value)) return "unknown"; // ChromeOS reports "Linux x86_64" elsewhere; it has no installer
    if (value.includes("android")) return "android";
    if (/iphone|ipad|ipod|\bios\b/.test(value)) return "ios";
    if (/mac|darwin/.test(value)) return "macos";
    if (value.includes("win")) return "windows";
    if (value.includes("linux")) return "linux";
    return undefined;
}

async function highEntropyArchitecture(nav: NavigatorInfo): Promise<ArchName> {
    const read = nav.userAgentData?.getHighEntropyValues;
    if (typeof read !== "function") return "unknown";
    try {
        const values = await read.call(nav.userAgentData, ["architecture"]);
        if (values.architecture === "arm") return "arm64";
        if (values.architecture === "x86") return "x64";
    } catch {
        // Unsupported or denied: treat the architecture as unknown.
    }
    return "unknown";
}

export async function detectPlatform(nav: NavigatorInfo): Promise<DetectedPlatform> {
    let os = osOf(nav.userAgentData?.platform) ?? osOf(nav.platform) ?? osOf(nav.userAgent) ?? "unknown";
    // Android reports navigator.platform "Linux armv8l"; only the user agent says Android.
    if (os === "linux" && osOf(nav.userAgent) === "android") os = "android";
    // iPadOS Safari reports a Mac platform; touch support distinguishes it.
    if (os === "macos" && (nav.maxTouchPoints ?? 0) > 1) os = "ios";
    const mobile = nav.userAgentData?.mobile === true || os === "ios" || os === "android";
    if (os === "ios" || os === "android" || os === "unknown") return {os, arch: "unknown", mobile};

    const reported = await highEntropyArchitecture(nav);
    if (os === "macos") return {os, arch: reported, mobile};
    // Windows and Linux default to x64; an ARM signal (client hints, or the UA/platform string) wins.
    const armText = /arm64|aarch64|armv\d/i.test(`${nav.platform ?? ""} ${nav.userAgent}`);
    return {os, arch: reported === "arm64" || (reported === "unknown" && armText) ? "arm64" : "x64", mobile};
}

export type AssetChoice = {
    os: "macos" | "windows" | "linux";
    arch: "arm64" | "x64";
    format: "dmg" | "exe" | "appimage" | "deb";
    /** Visitor-facing platform label. */
    label: string;
    /** `data-umami-event` value. */
    event: string;
    asset: ReleaseAsset;
};

// Names produced by apps/desktop/scripts/release-policy.mjs assetName():
// `Momoki_${version}_${target.replaceAll('-','_')}${suffix}`, suffix .dmg / _setup.exe / .AppImage / .deb.
const ASSET_NAME = /^Momoki_(\d+\.\d+\.\d+)_(macos_arm64\.dmg|macos_x64\.dmg|windows_x64_setup\.exe|linux_x64\.AppImage|linux_x64\.deb)$/;

const KINDS: Record<string, Omit<AssetChoice, "asset">> = {
    "macos_arm64.dmg": {
        os: "macos",
        arch: "arm64",
        format: "dmg",
        label: "macOS（Apple 芯片）",
        event: "download-macos-arm64"
    },
    "macos_x64.dmg": {os: "macos", arch: "x64", format: "dmg", label: "macOS（Intel 芯片）", event: "download-macos-x64"},
    "windows_x64_setup.exe": {
        os: "windows",
        arch: "x64",
        format: "exe",
        label: "Windows",
        event: "download-windows-x64"
    },
    "linux_x64.AppImage": {
        os: "linux",
        arch: "x64",
        format: "appimage",
        label: "Linux（AppImage）",
        event: "download-linux-x64-appimage"
    },
    "linux_x64.deb": {os: "linux", arch: "x64", format: "deb", label: "Linux（.deb）", event: "download-linux-x64-deb"},
};
const ORDER = Object.keys(KINDS);

export type AssetPick = {
    primary?: AssetChoice;
    alternatives: AssetChoice[];
    unsupportedReason?: string;
    ambiguous?: boolean;
};

export function pickAssets(release: LatestDesktopRelease, platform: DetectedPlatform): AssetPick {
    const found = new Map<string, AssetChoice>();
    for (const asset of release.assets) {
        const match = ASSET_NAME.exec(asset.name);
        // The embedded version must equal the release tag's, or the file belongs to another release.
        if (!match || match[1] !== release.version || found.has(match[2])) continue;
        found.set(match[2], {...KINDS[match[2]], asset});
    }
    const all = ORDER.flatMap(key => found.get(key) ?? []);

    if (platform.mobile || platform.os === "ios" || platform.os === "android" || platform.os === "unknown") return {alternatives: all};

    if (platform.os === "macos") {
        if (platform.arch === "unknown") {
            // Browsers cannot tell Apple silicon from Intel: no primary; both dmg files lead the list
            // (the card shows them side by side with a how-to-check hint).
            const macs = all.filter(choice => choice.os === "macos");
            return {ambiguous: true, alternatives: [...macs, ...all.filter(choice => choice.os !== "macos")]};
        }
        const primary = all.find(choice => choice.os === "macos" && choice.arch === platform.arch);
        return {primary, alternatives: all.filter(choice => choice !== primary)};
    }

    if (platform.arch !== "x64") {
        // Only x64 packages exist: never offer one to an ARM device.
        return {alternatives: all.filter(choice => choice.os !== platform.os), unsupportedReason: "暂无该架构的安装包"};
    }
    // Linux: AppImage runs on any distribution; the smaller .deb stays one click away as an alternative.
    const primary = all.find(choice => choice.os === platform.os && (platform.os === "windows" || choice.format === "appimage"));
    return {primary, alternatives: all.filter(choice => choice !== primary)};
}
