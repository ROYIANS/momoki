import {useProductQueryState} from "../../../../platform/product/queries";
import type {StoreTx} from "../../../../platform/storage/types";
import {INSTALL_GUIDE_URL} from "@momoki/distribution/releases";
import {ExternalLink} from "../../../../ui/icons";
import {isTauriRuntime} from "../../../../platform/runtime/runtimeIdentity";
import {SettingsGroup, SettingsRow} from "../SettingsCard";

/** Reads through the query's own snapshot; touching the shared store here commits the tx early. */
async function readScale(tx: StoreTx) {
    const projects = await tx.projects.count();
    const characters = await tx.characters.count();
    const scenes = await tx.scenes.count();
    const props = await tx.props.count();
    const styles = await tx.styles.count();
    return {projects, assets: characters + scenes + props + styles};
}

export function StorageSection({visibleRowIds}: { visibleRowIds?: string[] }) {
    const native = isTauriRuntime();
    const {value: scale, error: readError} = useProductQueryState(tx => readScale(tx));
    return <>
        <SettingsGroup title="本地数据">
            {(!visibleRowIds || visibleRowIds.includes("location")) && <SettingsRow
                title="数据存放位置"
                description={native ? "仅保存在本机应用目录" : "仅保存在本浏览器"}
            />}
            {(!visibleRowIds || visibleRowIds.includes("scale")) && <SettingsRow
                title="数据规模"
                description={readError ? "暂时无法读取数据规模，请稍后重试。" : scale ? `${scale.projects} 个项目 · ${scale.assets} 项素材设定` : "正在读取…"}
            />}
            {(!visibleRowIds || visibleRowIds.includes("backup")) && <SettingsRow
                title="备份与迁移"
                description="升级或换机前请先导出备份"
                control={<a className="settings-link" href={INSTALL_GUIDE_URL} target="_blank" rel="noreferrer">安装与备份说明<ExternalLink
                    aria-hidden/></a>}
            />}
        </SettingsGroup>
    </>;
}
