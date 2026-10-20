import {SearchConnection} from "./SearchConnection";
import {useProductQuery} from "../../../platform/product/queries";
import {Check, Coins, Plug, Search} from "../../../ui/icons";
import {ModelCatalogSection} from "./ModelCatalogSection";
import {useEffect, useMemo, useRef, useState} from "react";
import {toast} from "sonner";
import {showError} from "../../../app/errors/showError";
import {Badge} from "../../../ui/badge";
import {Button} from "../../../ui/button";
import {PageState} from "../../../app/layout/PageLayout";
import {SettingsGroup} from "./SettingsCard";
import {SidePanel} from "../../../app/layout/SidePanel";
import {Field} from "../../../ui/field";
import {Input} from "../../../ui/input";
import {deleteConnector, upsertConnector} from "../commands/connectors";
import type {ConnectorConfig, ConnectorDefinitionId} from "../models/connector";
import {CONNECTOR_CATALOG, type ConnectorDefinition} from "../models/catalog";
import {maskApiKey} from "../../agent/providers/openaiCompatible";
import {listConnectorModels, testConnectorConnection} from "../models/connectors";
import {redactCredentials} from "@cuepoint/agent-providers/http";

type EditorState = {
    definition: ConnectorDefinition;
    existing?: ConnectorConfig;
};

type EditorSession = EditorState & { baseUrl: string; apiKey: string };
type EditorOperation = { session: EditorSession; kind: "probe" | "test" | "save" | "disconnect" };

/** Hosted by the settings page: keys live in settings, so the rail is the settings rail, not a second shell. */
export function ConnectorsSection({visibleRowIds, onEditorOpenChange}: {
    visibleRowIds?: string[];
    onEditorOpenChange?: (open: boolean) => void;
} = {}) {
    const [section, setSection] = useState<"models" | "search" | "catalog">("models");
    const activeSection = !visibleRowIds || visibleRowIds.includes(section) ? section : visibleRowIds[0];
    const view = useProductQuery(async (db) => {
        try {
            return {connectors: await db.connectors.toArray()};
        } catch {
            return {error: "读取失败，请刷新后重试。"};
        }
    }, []);
    const connectors = view?.connectors;
    const byDefinition = useMemo(() => {
        const map = new Map<ConnectorDefinitionId, ConnectorConfig>();
        for (const connector of connectors ?? []) {
            map.set(connector.definitionId, connector);
        }
        return map;
    }, [connectors]);

    const [editor, setEditor] = useState<EditorState>();
    const [baseUrl, setBaseUrl] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [probeModels, setProbeModels] = useState<string[]>([]);
    const [testing, setTesting] = useState(false);
    const [probing, setProbing] = useState(false);
    const [opError, setOpError] = useState<string>();
    const [saving, setSaving] = useState(false);

    const mounted = useRef(true);
    const sessionRef = useRef<EditorSession | undefined>(undefined);
    const operationRef = useRef<EditorOperation | undefined>(undefined);
    const session = sessionRef.current;

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            operationRef.current = undefined;
        };
    }, []);

    useEffect(() => () => onEditorOpenChange?.(false), [onEditorOpenChange]);

    function writeLocked() {
        return operationRef.current?.kind === "save" || operationRef.current?.kind === "disconnect";
    }

    function currentOperation(operation: EditorOperation) {
        return mounted.current && sessionRef.current === operation.session && operationRef.current === operation;
    }

    function finishOperation(operation: EditorOperation) {
        if (!currentOperation(operation)) return;
        operationRef.current = undefined;
        setTesting(false);
        setProbing(false);
        setSaving(false);
    }

    function openEditor(definition: ConnectorDefinition, existing?: ConnectorConfig) {
        if (!mounted.current || writeLocked()) return;
        onEditorOpenChange?.(true);
        sessionRef.current = {
            definition,
            existing,
            baseUrl: existing?.baseUrl ?? definition.defaultBaseUrl,
            apiKey: ""
        };
        operationRef.current = undefined;
        setEditor({definition, existing});
        setBaseUrl(sessionRef.current.baseUrl);
        setApiKey("");
        setProbeModels([]);
        setOpError(undefined);
        setTesting(false);
        setProbing(false);
        setSaving(false);
    }

    function closeEditor() {
        if (!mounted.current || sessionRef.current !== session || writeLocked()) return;
        onEditorOpenChange?.(false);
        sessionRef.current = undefined;
        operationRef.current = undefined;
        setEditor(undefined);
        setOpError(undefined);
        setProbeModels([]);
        setTesting(false);
        setProbing(false);
        setSaving(false);
    }

    function changeCredential(field: "baseUrl" | "apiKey", value: string) {
        if (!mounted.current || !session || sessionRef.current !== session || writeLocked()) return;
        session[field] = value;
        // Transport has no AbortSignal: cancel publication and release only this
        // credential operation synchronously, before another callback can run.
        operationRef.current = undefined;
        setOpError(undefined);
        setTesting(false);
        setProbing(false);
        setProbeModels([]);
        if (field === "baseUrl") setBaseUrl(value);
        else setApiKey(value);
    }

    function credentials() {
        return {
            definitionId: session!.definition.id,
            baseUrl: session!.baseUrl,
            apiKey: session!.apiKey.trim() || session!.existing?.apiKey || "",
        };
    }

    async function handleProbeModels() {
        if (!mounted.current || !session || sessionRef.current !== session || operationRef.current) return;
        const operation: EditorOperation = {session, kind: "probe"};
        const request = credentials();
        operationRef.current = operation;
        setOpError(undefined);
        setProbing(true);
        try {
            const result = await listConnectorModels(request);
            if (!currentOperation(operation)) return;
            if (!result.ok) {
                showError({
                    title: "拉取模型失败", cause: new Error(result.message), actionName: "discover-models",
                    detail: redactCredentials(result.message, request.apiKey).slice(0, 300)
                });
                setProbeModels([]);
                return;
            }
            setProbeModels(result.models);
            toast.success(
                session.definition.id === "aihubmix"
                    ? `已获取 ${result.models.length} 个公开模型；API Key 请通过测试连接验证`
                    : result.models.length > 0
                        ? `探活成功，可见 ${result.models.length} 个模型`
                        : "探活成功，但接口未返回模型列表",
            );
        } catch (error) {
            if (currentOperation(operation)) showError({
                title: "拉取模型失败", cause: error, actionName: "discover-models",
                detail: redactCredentials(error instanceof Error ? error.message : "拉取失败", request.apiKey).slice(0, 300)
            });
        } finally {
            finishOperation(operation);
        }
    }

    async function handleTest() {
        if (!mounted.current || !session || sessionRef.current !== session || operationRef.current) return;
        const operation: EditorOperation = {session, kind: "test"};
        const request = credentials();
        operationRef.current = operation;
        setOpError(undefined);
        setTesting(true);
        try {
            const result = await testConnectorConnection(request);
            if (!currentOperation(operation)) return;
            if (!result.ok) {
                setOpError(redactCredentials(result.message, request.apiKey).slice(0, 300));
                return;
            }
            // Wait for the nested directory read before publishing success;
            // changing credentials retires both stages of this operation.
            if (result.via === "models") {
                const listed = await listConnectorModels(request);
                if (!currentOperation(operation)) return;
                if (listed.ok) setProbeModels(listed.models);
            }
            const detail = result.via === "models" && result.modelCount != null
                ? `（${result.modelCount} 个模型）` : "";
            toast.success(session.definition.id === "mimo" ? `模型目录读取成功${detail}；配音权限以实际生成为准` : result.via === "authenticated-read" ? "鉴权读取成功；具体模型权限以实际调用为准" : `连接成功${detail}`);
        } catch (error) {
            if (currentOperation(operation)) setOpError(redactCredentials(error instanceof Error ? error.message : "测试失败", request.apiKey).slice(0, 300));
        } finally {
            finishOperation(operation);
        }
    }

    async function handleSave() {
        if (!mounted.current || !session || sessionRef.current !== session || operationRef.current) return;
        const operation: EditorOperation = {session, kind: "save"};
        const request = {...credentials(), protocol: session.definition.protocol, label: session.definition.title};
        operationRef.current = operation;
        setOpError(undefined);
        setSaving(true);
        try {
            await upsertConnector(request);
            if (!currentOperation(operation)) return;
            operationRef.current = undefined;
            toast.success("已保存连接");
            closeEditor();
        } catch (error) {
            if (currentOperation(operation)) setOpError(redactCredentials(error instanceof Error ? error.message : "保存失败", request.apiKey).slice(0, 300));
        } finally {
            finishOperation(operation);
        }
    }

    async function handleDisconnect() {
        if (!mounted.current || !session?.existing || sessionRef.current !== session || operationRef.current) return;
        const operation: EditorOperation = {session, kind: "disconnect"};
        const request = credentials();
        const id = session.existing.id;
        operationRef.current = operation;
        setOpError(undefined);
        setSaving(true);
        try {
            await deleteConnector(id);
            if (!currentOperation(operation)) return;
            operationRef.current = undefined;
            toast.success("已断开连接");
            closeEditor();
        } catch (error) {
            if (currentOperation(operation)) setOpError(redactCredentials(error instanceof Error ? error.message : "断开失败", request.apiKey).slice(0, 300));
        } finally {
            finishOperation(operation);
        }
    }

    return (
        <div className="settings-connections">
            <div className="settings-subtabs" role="group" aria-label="连接分组">
                {(!visibleRowIds || visibleRowIds.includes("models")) &&
                    <button type="button" aria-pressed={activeSection === "models"}
                            onClick={() => setSection("models")}><Plug size={16}
                                                                       weight={activeSection === "models" ? "fill" : "regular"}
                                                                       aria-hidden/>模型连接</button>}
                {(!visibleRowIds || visibleRowIds.includes("search")) &&
                    <button type="button" aria-pressed={activeSection === "search"}
                            onClick={() => setSection("search")}><Search size={16}
                                                                         weight={activeSection === "search" ? "fill" : "regular"}
                                                                         aria-hidden/>网络搜索连接</button>}
                {(!visibleRowIds || visibleRowIds.includes("catalog")) &&
                    <button type="button" aria-pressed={activeSection === "catalog"}
                            onClick={() => setSection("catalog")}><Coins size={16}
                                                                         weight={activeSection === "catalog" ? "fill" : "regular"}
                                                                         aria-hidden/>模型目录</button>}
            </div>
            <div hidden={activeSection !== "models"}>{!view ?
                <PageState kind="loading" title="正在读取连接…"/> : view.error ?
                    <PageState kind="error" title="暂时无法读取连接" description={view.error}/> :
                    <SettingsGroup title="服务商">
                        {CONNECTOR_CATALOG.map((definition) => {
                            const existing = byDefinition.get(definition.id);
                            const connected = Boolean(existing);
                            return (
                                <section key={definition.id} aria-labelledby={`connector-${definition.id}`}
                                         className="settings-row settings-connector-row">
                                    <div
                                        className="bg-muted text-foreground flex size-10 shrink-0 items-center justify-center rounded-md text-xs font-semibold"
                                        aria-hidden>
                                        {definition.mark}
                                    </div>
                                    <div className="settings-row-copy">
                                        <h3 id={`connector-${definition.id}`}
                                            className="settings-row-title">{definition.title}</h3>
                                        <p className="settings-row-description">{definition.blurb}</p>
                                    </div>
                                    <div className="settings-row-control">
                                        {connected ? (
                                            <Badge variant="outline" className="gap-1">
                                                <Check className="size-3" aria-hidden/>
                                                已连接
                                            </Badge>
                                        ) : (
                                            <Badge variant="secondary">未连接</Badge>
                                        )}
                                        {connected ? (
                                            <Button variant="outline" size="sm"
                                                    aria-label={`编辑 ${definition.title} 连接`}
                                                    disabled={saving} onClick={() => openEditor(definition, existing)}>
                                                编辑
                                            </Button>
                                        ) : (
                                            <Button variant="brand" size="sm"
                                                    aria-label={`安装 ${definition.title} 连接`}
                                                    disabled={saving} onClick={() => openEditor(definition)}>
                                                <Plug className="size-3.5" aria-hidden/>
                                                安装
                                            </Button>
                                        )}
                                    </div>
                                </section>
                            );
                        })}
                    </SettingsGroup>}
            </div>
            <div className="settings-search-connection" hidden={activeSection !== "search"}><SearchConnection
                onEditorOpenChange={onEditorOpenChange}/></div>
            {activeSection === "catalog" && <div className="settings-model-catalog"><ModelCatalogSection/></div>}

            <SidePanel open={Boolean(editor)} onOpenChange={(open) => !open && closeEditor()} kind="connector-editor" width={460}
                       title={editor?.existing ? "编辑连接" : "安装连接"}
                       description={editor?.definition.id === "mimo"
                           ? "MiMo · 聊天和配音共用此连接。支持预置音色、音色设计与声音克隆；测试连接只读取模型目录，不发起生成。"
                           : editor?.definition.id === "aihubmix"
                               ? "AIHubMix · 聊天、图像与视频共用此连接。模型目录公开可读；测试连接仅验证任务列表读取权限，不发起生成。"
                               : editor?.definition.id === "apimart"
                                   ? "APIMart · 聊天、图像与视频共用此连接。测试连接仅查询模型，不发起生成。"
                                   : `${editor?.definition.title ?? ""} · OpenAI 兼容协议。此处只配置接入点；模型在聊天里选。`}
                       footer=<>
                        <div className="flex flex-wrap gap-2">
                            {editor?.existing ? (
                                <Button
                                    variant="ghost"
                                    className="text-destructive hover:text-destructive"
                                    disabled={testing || saving || probing}
                                    onClick={() => void handleDisconnect()}
                                >
                                    断开
                                </Button>
                            ) : null}
                        </div>
                        <div className="flex flex-wrap justify-end gap-2">
                            <Button
                                variant="outline"
                                disabled={testing || saving || probing}
                                onClick={() => void handleProbeModels()}
                            >
                                {probing ? "拉取中…" : editor?.definition.id === "aihubmix" ? "获取公开模型" : "拉取模型探活"}
                            </Button>
                            <Button
                                variant="outline"
                                disabled={testing || saving || probing}
                                onClick={() => void handleTest()}
                            >
                                {testing ? "测试中…" : "测试连接"}
                            </Button>
                            <Button
                                variant="brand"
                                disabled={testing || saving || probing}
                                onClick={() => void handleSave()}
                            >
                                {saving ? "保存中…" : "保存"}
                            </Button>
                        </div>
</>>
                    <div className="grid gap-4">
                        <Field label="Base URL">
                            <Input
                                type="url"
                                name="connector-base-url"
                                value={baseUrl}
                                disabled={saving}
                                onChange={(event) => changeCredential("baseUrl", event.target.value)}
                                placeholder={editor?.definition.defaultBaseUrl}
                                autoComplete="off"
                            />
                        </Field>
                        <Field label="API Key">
                            <Input
                                type="password"
                                name="connector-api-key"
                                value={apiKey}
                                disabled={saving}
                                onChange={(event) => changeCredential("apiKey", event.target.value)}
                                placeholder={
                                    editor?.existing
                                        ? `已保存 ${maskApiKey(editor.existing.apiKey)}（留空则保持）`
                                        : "sk-…"
                                }
                                autoComplete="new-password"
                            />
                        </Field>
                        {probeModels.length > 0 ? (
                            <div className="bg-muted/40 rounded-lg border px-3 py-2">
                                <p className="text-muted-foreground text-xs">
                                    {editor?.definition.id === "aihubmix" ? "公开模型目录（前 12 个，不代表 Key 权限）" : "探活可见模型（前 12 个）"}
                                </p>
                                <p className="mt-1 text-xs leading-5 break-all">
                                    {probeModels.slice(0, 12).join(" · ")}
                                    {probeModels.length > 12 ? ` · …共 ${probeModels.length} 个` : ""}
                                </p>
                            </div>
                        ) : null}
                    </div>
                    {opError ? <p role="alert" className="text-destructive shrink-0 px-1 text-sm break-words">{opError}</p> : null}
            </SidePanel>
        </div>
    );
}
