import {useEffect, useMemo, useRef, useState} from "react";
import {toast} from "sonner";
import {showError} from "../../../app/errors/showError";
import {Button} from "../../../ui/button";
import {Checkbox} from "../../../ui/checkbox";
import {SidePanel} from "../../../app/layout/SidePanel";
import {Input} from "../../../ui/input";
import scopeJson from "../modelCatalog/scope.json";
import {
    buildCatalogRows,
    type CatalogRow,
    fetchCatalogIndex,
    getCatalogSelection,
    MAX_SELECTION_KEYS,
    putCatalogSelection,
} from "../modelCatalog/sync";
import type {CatalogEntry} from "../modelCatalog/types";
import {commonScopeCount, filterRows, rowSelected, selectedCount, setRows, toggleRow} from "./catalogRows";
import {PriceCells, PriceHeader} from "./PriceCells";
import {VirtualRows} from "./VirtualRows";

const PICKER_GRID = "grid grid-cols-[minmax(0,1fr)_repeat(4,56px)] items-center gap-2";
const SCOPE_PROVIDERS = [...scopeJson.fullProviders, ...scopeJson.originProviders];

/** Mounted only while open, so draft state and the downloaded full list are released on close. */
export function ModelCatalogPicker({entries, onClose}: { entries: readonly CatalogEntry[]; onClose: () => void }) {
    const [autoCommon, setAutoCommon] = useState(true);
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const [ready, setReady] = useState(false);
    const [saving, setSaving] = useState(false);
    const [index, setIndex] = useState<CatalogRow[]>();
    const [loadingIndex, setLoadingIndex] = useState(false);
    const [provider, setProvider] = useState("");
    const [search, setSearch] = useState("");
    const [limitReached, setLimitReached] = useState(false);
    const loadRef = useRef<AbortController | undefined>(undefined);

    useEffect(() => {
        let current = true;
        void getCatalogSelection().then(selection => {
            if (!current) return;
            setAutoCommon(selection.autoIncludeCommon);
            setSelected(new Set(selection.modelKeys));
            setReady(true);
        });
        return () => {
            current = false;
            loadRef.current?.abort();
        };
    }, []);

    const baseRows = useMemo(() => buildCatalogRows(entries), [entries]);
    const rows = index ?? baseRows;
    const visible = useMemo(() => filterRows(rows, {provider, search}), [rows, provider, search]);
    const providers = useMemo(() => {
        const names = new Map<string, string>();
        for (const row of rows) for (const id of row.providers) names.set(id, id === row.provider ? row.providerName : names.get(id) ?? id);
        return [...names].sort((a, b) => a[1].localeCompare(b[1]));
    }, [rows]);
    const commonCount = useMemo(() => commonScopeCount(entries, SCOPE_PROVIDERS), [entries]);

    function update(next: Set<string> | undefined) {
        setLimitReached(!next);
        if (next) setSelected(next);
    }

    async function loadIndex() {
        if (loadRef.current) {
            loadRef.current.abort();
            return;
        }
        const controller = new AbortController();
        loadRef.current = controller;
        setLoadingIndex(true);
        const result = await fetchCatalogIndex({signal: controller.signal});
        if (loadRef.current !== controller) return;
        loadRef.current = undefined;
        setLoadingIndex(false);
        if (result.ok) setIndex(result.rows);
        else if (result.code !== "cancelled") showError({
            title: "加载完整清单失败",
            cause: new Error(result.message),
            actionName: "load-model-catalog-index",
            detail: result.message
        });
    }

    async function save() {
        setSaving(true);
        try {
            await putCatalogSelection({autoIncludeCommon: autoCommon, modelKeys: [...selected]});
            toast.success("已保存选择，点击「立即同步」后生效");
            onClose();
        } catch (error) {
            showError({
                title: "保存模型选择失败",
                cause: error,
                actionName: "save-model-catalog-selection",
                detail: error instanceof Error ? error.message : undefined
            });
            setSaving(false);
        }
    }

    return (
        <SidePanel open onOpenChange={open => {
            if (!open && !saving) onClose();
        }} kind="model-catalog" width={520} title="选择模型" description="勾选要同步到本机的模型。归一化 ID 相同的选项只会导入一次。"
                   footer=<>
                    <Button variant="outline" disabled={saving} onClick={onClose}>取消</Button>
                    <Button variant="brand" disabled={!ready || saving}
                            onClick={() => void save()}>{saving ? "保存中…" : "保存"}</Button>
</>>
                <div className="grid min-h-0 gap-3">
                    <label className="flex items-center gap-2 text-sm">
                        <Checkbox checked={autoCommon} disabled={!ready}
                                  onCheckedChange={value => setAutoCommon(value === true)}/>
                        自动包含常用模型（当前目录中 {commonCount} 个）
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                        <Input className="min-w-40 flex-1" value={search} placeholder="搜索名称或 ID"
                               aria-label="搜索名称或 ID"
                               onChange={event => setSearch(event.target.value)}/>
                        <select className="border-input h-9 max-w-44 rounded-md border bg-transparent px-2 text-sm"
                                value={provider}
                                aria-label="供应商" onChange={event => setProvider(event.target.value)}>
                            <option value="">全部供应商</option>
                            {providers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                        </select>
                        <Button variant="outline" size="sm" onClick={() => void loadIndex()}
                                disabled={Boolean(index) && !loadingIndex}>
                            {loadingIndex ? "取消加载" : index ? "已加载完整清单" : "加载完整清单"}
                        </Button>
                    </div>
                    {!index && <p className="text-muted-foreground text-xs">
                        {loadingIndex ? "正在从 models.dev 下载完整清单（约 6 MB）…" : "目前只列出当前目录中的模型；点击「加载完整清单」从 models.dev 获取全部模型（约 6 MB，不会发送任何本机数据）。"}
                    </p>}
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Button variant="outline" size="sm" disabled={!visible.length || !ready}
                                onClick={() => update(setRows(visible, selected, true))}>
                            全选筛选结果（{visible.length}）
                        </Button>
                        <Button variant="outline" size="sm" disabled={!visible.length || !ready}
                                onClick={() => update(setRows(visible, selected, false))}>
                            清空筛选结果
                        </Button>
                        <span role="status"
                              className="text-muted-foreground ml-auto text-xs">已选 {selectedCount(rows, selected)} 个模型</span>
                    </div>
                    {limitReached && <p role="alert"
                                        className="text-destructive text-xs">最多只能选择 {MAX_SELECTION_KEYS} 个条目，请先清空一部分。</p>}
                    <div className={`${PICKER_GRID} text-muted-foreground px-3 text-xs`} aria-hidden>
                        <span>模型 · USD / 每百万 Tokens</span><PriceHeader/>
                    </div>
                    {visible.length ?
                        <VirtualRows count={visible.length} rowHeight={56} viewportHeight={320} label="可选模型"
                                     renderRow={position => {
                                         const row = visible[position];
                                         return (
                                             <label className={`${PICKER_GRID} h-full cursor-pointer px-3`}>
                                    <span className="flex min-w-0 items-center gap-3">
                                        <Checkbox checked={rowSelected(row, selected)} disabled={!ready}
                                                  aria-label={row.name}
                                                  onCheckedChange={value => update(toggleRow(row, selected, value === true))}/>
                                        <span className="min-w-0">
                                            <span className="block truncate text-sm">{row.name}
                                                <span
                                                    className="text-muted-foreground"> · {row.providerName}{row.releaseDate ? ` · ${row.releaseDate}` : ""}</span>
                                            </span>
                                            <span
                                                className="text-muted-foreground block truncate font-mono text-xs">{row.id}</span>
                                        </span>
                                    </span>
                                                 <PriceCells cost={row.cost}/>
                                             </label>
                                         );
                                     }}/> :
                        <p className="text-muted-foreground py-8 text-center text-sm">没有匹配的模型</p>}
                </div>
        </SidePanel>
    );
}
