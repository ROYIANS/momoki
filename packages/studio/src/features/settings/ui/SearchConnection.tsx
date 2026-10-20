import {useEffect, useId, useRef, useState} from 'react';
import {useProductQuery} from '../../../platform/product/queries';
import {toast} from 'sonner';
import {getSearchConnectionState, removeSearchConnection, saveSearchConnection} from '../commands/searchConnections';
import {testSearchConnection} from '../../references/providers/tavily';
import {Button} from '../../../ui/button';
import {Input} from '../../../ui/input';
import {Checkbox} from '../../../ui/checkbox';
import {Field} from '../../../ui/field';
import {SidePanel} from '../../../app/layout/SidePanel';

export function SearchConnection({onEditorOpenChange}: { onEditorOpenChange?: (open: boolean) => void }) {
    const enabledId = useId();
    const view = useProductQuery(async (db) => {
        try {
            return {state: await getSearchConnectionState(db)};
        } catch {
            return {error: '读取失败，请刷新后重试。'};
        }
    }, []);
    const state = view?.state;
    const [open, setOpen] = useState(false);
    const [key, setKey] = useState('');
    const [enabled, setEnabled] = useState(true);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState('');
    const pending = useRef(false);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    async function act(action: 'save' | 'remove' | 'test') {
        if (!mounted.current || pending.current) return;
        pending.current = true;
        setBusy(true);
        setFeedback('');
        try {
            if (action === 'test') {
                const result = await testSearchConnection(key);
                if (!mounted.current) return;
                setFeedback(result.message);
            } else {
                if (action === 'save') await saveSearchConnection({apiKey: key, enabled});
                else await removeSearchConnection();
                if (!mounted.current) return;
                setKey('');
                setOpen(false);
                onEditorOpenChange?.(false);
                toast.success(action === 'save' ? '已保存搜索连接' : '已移除搜索连接');
            }
        } catch {
            if (mounted.current) setFeedback('操作失败，请重试；填写的内容已保留');
        } finally {
            pending.current = false;
            if (mounted.current) setBusy(false);
        }
    }

    return <section className="mt-6" aria-label="联网搜索">
        <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1"><h2 className="text-base leading-6 font-semibold">联网搜索</h2><p
                className="text-muted-foreground mt-1 text-sm leading-[22px]">Tavily ·
                为智能模式提供网络搜索与网页读取。单独配置密钥，使用当前对话模型分析资料。</p><p
                role={view?.error ? 'alert' : !view ? 'status' : undefined}
                className="text-muted-foreground mt-1 text-xs leading-[18px]">{view?.error ?? (!state ? '正在读取搜索连接…' : state.configured ? state.enabled ? '已配置 · 已启用' : '已配置 · 已停用' : '未配置')}</p>
            </div>
            <Button variant="outline" size="sm" disabled={!state} onClick={() => {
                if (!mounted.current || pending.current) return;
                onEditorOpenChange?.(true);
                setKey('');
                setEnabled(state?.enabled ?? true);
                if (!state?.configured) setEnabled(true);
                setFeedback('');
                setOpen(true);
            }}>配置 Tavily</Button>
        </div>
        <SidePanel open={open} onOpenChange={(value) => {
            if (mounted.current && !pending.current) {
                setOpen(value);
                onEditorOpenChange?.(value);
                if (!value) setKey('');
            }
        }} kind="search-connection" width={440} title="Tavily 联网搜索"
                   description="密钥仅保存在本机，不进入项目备份或 AI 上下文。保存不发送请求；测试仅查询鉴权，不执行搜索。"
                   footer=<>
                    {state?.configured && <Button variant="ghost" disabled={busy}
                                                  onClick={() => void act('remove')}>移除搜索连接</Button>}
                    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy}
                                                                  onClick={() => void act('test')}>测试搜索连接</Button><Button
                        disabled={busy || !key.trim() && !state?.configured}
                        onClick={() => void act('save')}>保存搜索连接</Button></div>
</>>
                <div className="grid gap-4">
                    <Field label="Tavily API Key"><Input type="password" name="tavily-api-key" value={key}
                                                         disabled={busy}
                                                         onChange={(event) => setKey(event.target.value)}
                                                         placeholder={state?.configured ? '已保存密钥（留空则保持）' : 'tvly-…'}
                                                         autoComplete="new-password"/></Field>
                    <div className="flex items-center gap-2 text-sm"><Checkbox id={enabledId} checked={enabled}
                                                                               disabled={busy}
                                                                               onCheckedChange={(value) => setEnabled(value === true)}/><label
                        htmlFor={enabledId}>启用联网搜索</label></div>
                    <p className="text-muted-foreground text-xs leading-5">启用后会为后续智能对话开启「联网调研」技能；你仍可在对话的技能菜单中关闭。搜索和读取网页可能消耗服务额度。</p>
                    {feedback && <p role="status" className="text-sm leading-6">{feedback}</p>}
                </div>
        </SidePanel>
    </section>;
}
