import {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Button} from '@momoki/studio/reference/components/ui/button';
import {acceptanceRequest} from './bridge';
import {type AcceptanceEvent, Evidence, message} from './acceptanceEvidence';
import {checkTavilyNative} from './tavilyProbe';
import '@momoki/studio/reference/styles.css';
import './prototype.css';

function TavilyProbe() {
    const [events, setEvents] = useState<AcceptanceEvent[]>([]);
    const [evidence] = useState(() => new Evidence(setEvents));
    const [status, setStatus] = useState('等待明确点击；仅运行本机合成接口。');
    const [started, setStarted] = useState(false);
    const [busy, setBusy] = useState(false);
    const operation = useRef(false);
    useEffect(() => {
        void acceptanceRequest({type: 'ready'}).catch((error: unknown) => setStatus(message(error)));
    }, []);
    const run = async () => {
        if (operation.current) return;
        operation.current = true;
        setStarted(true);
        setBusy(true);
        try {
            await checkTavilyNative(evidence, __STREAM_ENDPOINT__);
            setStatus('合成原生协议检查完成；真实搜索与整体验收仍单独记录。');
        } catch (error) {
            evidence.record('原生 Tavily 合成探针：动作失败', false, {error: message(error)});
            setStatus(message(error));
        } finally {
            try {
                await evidence.persist();
            } catch (error) {
                setStatus(message(error));
            }
            setBusy(false);
        }
    };
    return <main className="prototype-main dark"><h1>Tavily 原生合成接口验收</h1>
        <p>独立应用、独立本机数据。共享适配器的三个固定接口由明确测试入口映到本机服务；不联系 Tavily，不使用真实 Key。</p>
        <p>此报告保持 unfinished，不表示正式产品、真实网络搜索或历史验收全部完成。</p>
        <Button disabled={started || busy} onClick={() => void run()}>验证 Tavily 原生合成接口</Button><p
            role="status">{status}</p>
        <ol className="acceptance-log">{events.map((event, index) => <li key={index}
                                                                         data-ok={event.ok}>{event.ok ? '通过' : '失败'} · {event.name}
            <pre>{JSON.stringify(event.detail, null, 2)}</pre>
        </li>)}</ol>
    </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Tavily probe root missing');
createRoot(root).render(<TavilyProbe/>);
