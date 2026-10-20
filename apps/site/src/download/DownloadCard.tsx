import {formatBytes, formatPublished} from "./format";
import {type AssetChoice, type DetectedPlatform, pickAssets} from "@momoki/distribution/platform";
import {
    type FallbackReason,
    INSTALL_GUIDE_URL,
    type LatestDesktopRelease,
    type ReleaseResult,
    RELEASES_URL
} from "@momoki/distribution/releases";

const FALLBACK_TEXT: Record<FallbackReason, string> = {
    network: "暂时无法获取最新版本信息，请直接到 GitHub 查看所有版本。",
    "rate-limit": "GitHub 接口暂时限流，无法获取最新版本信息，请直接到 GitHub 查看所有版本。",
    "no-release": "暂时没有可下载的桌面版发布，请到 GitHub 查看进展。",
    invalid: "暂时无法读取版本信息，请直接到 GitHub 查看所有版本。",
};

const EXTERNAL = {rel: "noopener noreferrer"} as const;

function DownloadLink({choice, primary}: { choice: AssetChoice; primary?: boolean }) {
    return (
        <a className={primary ? "lp-btn lp-btn-primary" : "lp-btn"} href={choice.asset.url} {...EXTERNAL}
           data-umami-event={choice.event}>
            {primary ? `下载 ${choice.label} 版` : choice.label}
        </a>
    );
}

function fileMeta(choice: AssetChoice) {
    const size = formatBytes(choice.asset.size);
    return size ? `${choice.asset.name} · ${size}` : choice.asset.name;
}

function Ready({release, platform}: { release: LatestDesktopRelease; platform: DetectedPlatform }) {
    const pick = pickAssets(release, platform);
    const macChoices = pick.ambiguous ? pick.alternatives.filter(choice => choice.os === "macos") : [];
    const others = pick.alternatives.filter(choice => !macChoices.includes(choice));
    const published = formatPublished(release.publishedAt);
    const shown = [...(pick.primary ? [pick.primary] : []), ...macChoices, ...others].filter(choice => choice.asset.sha256);
    const offersInstaller = Boolean(pick.primary) || macChoices.length > 0;

    return (
        <>
            <p className="lp-dl-version">
                最新版本 v{release.version}
                {release.prerelease ? <span className="lp-badge">预发布</span> : null}
                {published ? <span>发布于 {published}</span> : null}
            </p>
            {platform.mobile || platform.os === "unknown" ? (
                <p className="lp-dl-status">{platform.mobile ? "默默桌面版需要安装在电脑上。你可以先在浏览器中体验，或用电脑打开本页下载。" : "没有识别出你的系统，可在下方选择对应的安装包。"}</p>
            ) : pick.unsupportedReason ? (
                <p className="lp-dl-status"><strong>{pick.unsupportedReason}</strong>：目前只提供 x64 安装包，不适用于 ARM
                    设备。可以先在浏览器中体验，或到 GitHub 查看所有版本。</p>
            ) : pick.ambiguous ? (
                <>
                    <p className="lp-dl-status">浏览器无法判断你的 Mac 使用哪种芯片，请选择对应的安装包。</p>
                    <div className="lp-dl-buttons">{macChoices.map(choice => <DownloadLink key={choice.asset.name}
                                                                                           choice={choice}/>)}</div>
                    <p className="lp-dl-meta">如何判断：点击屏幕左上角苹果菜单，选择“关于本机”；芯片显示 Apple M 系列选
                        Apple 芯片，显示 Intel 选 Intel 芯片。</p>
                </>
            ) : pick.primary ? (
                <>
                    <div className="lp-dl-buttons"><DownloadLink choice={pick.primary} primary/></div>
                    <p className="lp-dl-meta">{fileMeta(pick.primary)}</p>
                    {pick.primary.format === "appimage" ?
                        <p className="lp-dl-meta">Debian / Ubuntu 用户也可在下方“其它安装包”中选择体积更小的
                            .deb。</p> : null}
                </>
            ) : (
                <p className="lp-dl-status">这个版本暂时没有适合你系统的安装包，请到 GitHub 查看所有版本。</p>
            )}
            {offersInstaller ? (
                <p className="lp-dl-meta">当前为测试版，安装包未签名，首次打开可能有系统安全提示，<a
                    href={INSTALL_GUIDE_URL} {...EXTERNAL}>查看安装指南</a>。</p>
            ) : null}
            {others.length > 0 ? (
                <details className="lp-dl-details">
                    <summary>其它安装包</summary>
                    <ul>
                        {others.map(choice => (
                            <li key={choice.asset.name}>
                                <a href={choice.asset.url} {...EXTERNAL}
                                   data-umami-event={choice.event}>{choice.label}</a>
                                <span>{fileMeta(choice)}</span>
                            </li>
                        ))}
                    </ul>
                </details>
            ) : null}
            {shown.length > 0 ? (
                <details className="lp-dl-details">
                    <summary>SHA256 校验值</summary>
                    <ul>
                        {shown.map(choice => <li key={choice.asset.name}>
                            <code>{choice.asset.sha256}</code><span>{choice.asset.name}</span></li>)}
                    </ul>
                    <p className="lp-dl-meta">也可以下载同一版本发布页里的 SHA256SUMS 文件，用它核对下载的安装包。<a
                        href={release.htmlUrl} {...EXTERNAL}>打开发布页</a></p>
                </details>
            ) : null}
        </>
    );
}

// Keep the loading markup in sync with the static #download block of landing.html
// (tests/landingEntry.test.ts compares them).
export function DownloadCard({release, platform}: { release?: ReleaseResult; platform?: DetectedPlatform }) {
    const loading = !release || (release.kind === "ok" && !platform);
    return (
        <section className="lp-section" id="download" aria-labelledby="lp-download">
            <h2 id="lp-download">下载桌面版</h2>
            <div className="lp-download" aria-busy={loading}>
                {!release || loading ? (
                    <p className="lp-dl-status">正在查找最新版本…</p>
                ) : release.kind === "fallback" ? (
                    <p className="lp-dl-status">{FALLBACK_TEXT[release.reason]}</p>
                ) : platform ? (
                    <Ready release={release.release} platform={platform}/>
                ) : null}
                <p className="lp-dl-all"><a href={RELEASES_URL} {...EXTERNAL}>在 GitHub 查看所有版本</a></p>
            </div>
        </section>
    );
}
