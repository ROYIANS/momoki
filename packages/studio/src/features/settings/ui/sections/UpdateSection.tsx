import {useEffect} from "react";
import {Link} from "@tanstack/react-router";
import {Button} from "../../../../ui/button";
import {Download, ExternalLink, RefreshCw} from "../../../../ui/icons";
import {appVersion} from "../../../../platform/runtime/appVersion";
import {MAX_RELEASE_ASSET_BYTES} from "../../updates/download";
import {INSTALL_GUIDE_URL, RELEASES_URL} from "@momoki/distribution/releases";
import {isTauriRuntime} from "../../../../platform/runtime/runtimeIdentity";
import {SettingsGroup, SettingsRow} from "../SettingsCard";
import {useUpdateCheck} from "../useUpdateCheck";

function megabytes(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function publishedOn(value: string | undefined): string {
    if (!value || !Number.isFinite(Date.parse(value))) return "";
    return new Date(value).toLocaleDateString("zh-CN");
}

export function UpdateSection({visibleRowIds}: { visibleRowIds?: string[] }) {
    const native = isTauriRuntime();
    const {state, download, runCheck, startDownload, cancelDownload} = useUpdateCheck();
    useEffect(() => {
        // StrictMode replays setup/cleanup; only the surviving page starts a request.
        let live = true;
        queueMicrotask(() => {
            if (live) void runCheck();
        });
        return () => {
            live = false;
        };
    }, [runCheck]);

    const release = state.kind === "ready" ? state.release : undefined;
    const choices = state.kind === "ready" ? [...(state.asset ? [state.asset] : []), ...(state.alternatives ?? [])] : [];
    const busy = download.kind === "downloading" || download.kind === "verifying" || download.kind === "saving";
    const visible = (id: string) => !visibleRowIds || visibleRowIds.includes(id);
    const releaseLink = <Button variant="outline" size="sm" asChild><a href={release?.htmlUrl ?? RELEASES_URL}
                                                                       target="_blank"
                                                                       rel="noreferrer">打开发布页<ExternalLink
        aria-hidden/></a></Button>;
    const date = publishedOn(release?.publishedAt);
    const installSteps = download.kind === "saved"
        ? download.format === "dmg" ? "打开 dmg 后将默默拖入应用程序文件夹。"
            : download.format === "appimage" ? "先给 AppImage 文件添加执行权限，再运行安装包。"
                : download.format === "deb" ? "用系统的软件安装器打开 .deb 文件。" : "先退出默默，再运行 setup.exe 安装。"
        : "";

    return <>
        {(visible("version") || visible("check") || visible("release")) && <SettingsGroup title="版本与更新">
            {visible("version") && <SettingsRow title="当前版本" description={`默默 ${appVersion()}`}/>}
            {visible("check") && <>
                <SettingsRow
                    title="检查更新"
                    description={state.kind === "checking" ? "正在检查…" : release
                        ? `最新桌面版本 ${release.version}${release.prerelease ? "（预发布）" : ""}${date ? ` · 发布于 ${date}` : ""}`
                        : "从发布页获取最新版本"}
                    control={<Button variant="outline" size="sm" disabled={state.kind === "checking" || busy}
                                     onClick={() => void runCheck()}><RefreshCw aria-hidden/>检查更新</Button>}
                />
                {state.kind === "failed" &&
                    <div role="alert"><SettingsRow title="检查失败" description={state.reason} control={releaseLink}/>
                    </div>}
                {state.kind === "ready" && state.verdict === "update-available" && <>
                    <SettingsRow
                        title={`发现新版本 ${release?.version ?? ""}`}
                        description={choices.length
                            ? `${state.ambiguous ? "请在「关于本机」确认芯片类型，再选择 Apple 或 Intel 安装包。" : ""}升级前请先导出备份。`
                            : `${state.unsupportedReason ?? "当前平台没有可直接下载的安装包"}，请前往发布页查看。`}
                        control={!choices.length ? releaseLink : undefined}
                    />
                    {choices.map(choice => {
                        const inApp = native && Boolean(choice.asset.sha256) && choice.asset.size <= MAX_RELEASE_ASSET_BYTES;
                        return <SettingsRow key={choice.asset.name} title={choice.label}
                                            description={`${choice.asset.name}${!inApp ? ` · ${native ? !choice.asset.sha256 ? "此版本未提供校验值，" : "安装包超过 64 MB，" : ""}通过系统浏览器下载` : ""}`}
                                            control={inApp
                                                ? <Button size="sm" disabled={busy}
                                                          onClick={() => void startDownload(choice)}><Download
                                                    aria-hidden/>下载（{megabytes(choice.asset.size)}）</Button>
                                                : <Button size="sm" asChild><a href={choice.asset.url} target="_blank"
                                                                               rel="noreferrer"><Download
                                                    aria-hidden/>浏览器下载（{megabytes(choice.asset.size)}）</a></Button>}
                        />;
                    })}
                </>}
                {state.kind === "ready" && state.verdict === "up-to-date" &&
                    <SettingsRow title="已是最新版本"/>}
                {state.kind === "ready" && state.verdict === "ahead" &&
                    <SettingsRow title="当前版本高于线上"/>}
                {state.kind === "ready" && state.verdict === "unknown" && <SettingsRow title="无法比较版本"
                                                                                       description="请前往发布页查看"/>}
            </>}
            {visible("release") &&
                <SettingsRow title="发布页" control={releaseLink}/>}
        </SettingsGroup>}
        {download.kind !== "idle" && <div role={download.kind === "failed" ? "alert" : "status"}>
            <SettingsGroup title="安装包">
                <SettingsRow
                    title={download.kind === "saved" ? download.warning ? "安装包已保存，请检查文件" : "安装包已保存" : download.kind === "failed" ? "下载失败" : download.kind === "canceled" ? "已取消下载或保存" : "正在下载安装包"}
                    description={download.kind === "saved" ? `${download.name}。${download.warning ?? installSteps}`
                        : download.kind === "failed" ? `${download.message} 也可以前往发布页手动下载。`
                            : download.kind === "canceled" ? "没有保存安装包，可以重新下载。"
                                : download.kind === "saving" ? "请选择保存位置，正在等待系统保存完成…"
                                    : download.kind === "verifying" ? "正在校验文件完整性…" : `${megabytes(download.loaded)} / ${megabytes(download.total)}`}
                    control={busy ?
                        <Button variant="outline" size="sm" onClick={cancelDownload}>取消</Button> : undefined}
                />
                {(download.kind === "saved" || download.kind === "failed") &&
                    <SettingsRow title="安装与备份说明" description="覆盖安装前先导出备份"
                                 control={<Button variant="outline" size="sm" asChild><a href={INSTALL_GUIDE_URL}
                                                                                         target="_blank"
                                                                                         rel="noreferrer">查看说明<ExternalLink
                                     aria-hidden/></a></Button>}/>}
            </SettingsGroup>
        </div>}
        {(visible("privacy") || visible("about")) && <SettingsGroup title="关于默默">
            {visible("privacy") && <SettingsRow title="数据与隐私"
                                                description="项目与密钥只保存在本机，检查更新不会上传它们"/>}
            {visible("about") && <SettingsRow title="更多关于 Momoki"
                                              control={<Button variant="outline" size="sm" asChild><Link
                                                  to="/about">关于默默</Link></Button>}/>}
        </SettingsGroup>}
    </>;
}
