import {withThreadRunLock} from '@momoki/studio/reference/lib/agent/runOwnership';
import {assert, Evidence} from './acceptanceEvidence';

const PREFIX = '原生 Web Locks：';
const DEADLINE_MS = 5000;

function gate() {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>(accept => {
        resolve = accept;
    });
    return {promise, resolve};
}

/** Acceptance-only: real default manager, no injected locks and no provider calls. */
export async function checkNativeLocks(evidence: Evidence) {
    const firstEvent = evidence.events.length;
    const releases = new Set<() => void>();
    const controllers = new Set<AbortController>();
    const pending = new Set<Promise<unknown>>();
    const observe = <T, >(promise: Promise<T>) => {
        pending.add(promise);
        void promise.then(() => pending.delete(promise), () => pending.delete(promise));
        return promise;
    };
    const bounded = async <T, >(promise: Promise<T>, label: string): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([observe(promise), new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} 超过 ${DEADLINE_MS} ms`)), DEADLINE_MS);
            })]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    };
    const heldGate = () => {
        const held = gate();
        releases.add(held.resolve);
        return held;
    };
    const threadId = `native-lock-probe-${crypto.randomUUID()}`;
    const ownerName = `momoki:agent:${threadId}`;
    try {
        const available = await evidence.check(`${PREFIX}真实安全上下文与默认管理器`, async () => {
            assert(isSecureContext, '实际打包上下文不是 secure context');
            assert(typeof navigator.locks?.request === 'function', '实际 navigator.locks 不可用');
            assert(typeof navigator.locks.query === 'function', '实际 navigator.locks.query 不可用');
            const snapshot = await bounded(navigator.locks.query(), '读取锁状态');
            return {
                secureContext: isSecureContext,
                origin: location.origin,
                manager: 'navigator.locks',
                injected: false,
                held: snapshot.held?.length ?? 0
            };
        }, value => value);
        if (!available) return;
        const locks = navigator.locks;

        await evidence.check(`${PREFIX}默认 Agent 同名排他与异名独立`, async () => {
            const entered = gate(), hold = heldGate();
            let ownerCalls = 0, conflictCalls = 0;
            const owner = observe(withThreadRunLock(threadId, async () => {
                ownerCalls++;
                entered.resolve();
                await hold.promise;
                return 'owner-released';
            }));
            try {
                await bounded(entered.promise, '默认 Agent owner 进入');
                const snapshot = await bounded(locks.query(), '默认 Agent owner 状态');
                assert(snapshot.held?.some(lock => lock.name === ownerName && lock.mode === 'exclusive'), '默认 helper 未持有真实排他锁');
                let conflict: unknown;
                try {
                    await bounded(withThreadRunLock(threadId, () => {
                        conflictCalls++;
                        return Promise.resolve();
                    }), '同名竞争');
                } catch (error) {
                    conflict = error;
                }
                assert(conflict instanceof Error && conflict.message.includes('另一个页面'), '同名竞争没有被现有 owner guard 拒绝');
                assert(conflictCalls === 0 && ownerCalls === 1, '竞争执行闭包被调用或 owner 次数错误');
                const independent = await bounded(withThreadRunLock(`${threadId}-independent`, () => Promise.resolve('independent')), '不同会话');
                assert(independent === 'independent', '不同会话无法独立执行');
                return {
                    ownerName,
                    ownerCalls,
                    conflictExecuteCalls: conflictCalls,
                    independentWhileHeld: true,
                    defaultManager: true
                };
            } finally {
                hold.resolve();
                await bounded(owner, '正常 owner 释放');
            }
        }, value => value);

        await evidence.check(`${PREFIX}正常释放后重新取得默认 Agent 锁`, async () => {
            const result = await bounded(withThreadRunLock(threadId, () => Promise.resolve('reacquired')), '正常释放后重取');
            assert(result === 'reacquired', '正常释放后无法重新取得锁');
            return {ownerName, reacquired: true, defaultManager: true};
        }, value => value);

        await evidence.check(`${PREFIX}异常保留原错误且释放默认 Agent 锁`, async () => {
            const sentinel = new Error('native-lock-probe-sentinel');
            let received: unknown;
            try {
                await bounded(withThreadRunLock(threadId, () => Promise.reject(sentinel)), '异常执行');
            } catch (error) {
                received = error;
            }
            assert(received === sentinel, '执行异常没有保留原始错误');
            const result = await bounded(withThreadRunLock(threadId, () => Promise.resolve('after-error')), '异常释放后重取');
            assert(result === 'after-error', '异常结束后仍占有锁');
            return {ownerName, originalErrorIdentity: true, reacquired: true, defaultManager: true};
        }, value => value);

        await evidence.check(`${PREFIX}真实 API 排队 AbortSignal 取消与释放`, async () => {
            const name = `${ownerName}:api-queue`, entered = gate(), hold = heldGate();
            let queuedCalls = 0;
            const owner = observe(locks.request(name, {mode: 'exclusive'}, async () => {
                entered.resolve();
                await hold.promise;
            }));
            const controller = new AbortController();
            controllers.add(controller);
            try {
                await bounded(entered.promise, 'API queue owner 进入');
                const queued = observe(locks.request(name, {mode: 'exclusive', signal: controller.signal}, () => {
                    queuedCalls++;
                    return Promise.resolve();
                }));
                const snapshot = await bounded(locks.query(), '读取真实排队请求');
                assert(snapshot.pending?.some(lock => lock.name === name), '没有观察到真实排队请求');
                controller.abort();
                let rejection: unknown;
                try {
                    await bounded(queued, '排队请求取消');
                } catch (error) {
                    rejection = error;
                }
                assert(rejection instanceof DOMException && rejection.name === 'AbortError', '排队请求未返回实际 AbortError');
                assert(queuedCalls === 0, '已取消的排队执行闭包被调用');
                hold.resolve();
                await bounded(owner, 'API queue owner 释放');
                const again = await bounded(locks.request(name, {ifAvailable: true}, lock => {
                    assert(lock, '取消后重取失败');
                    return Promise.resolve('reacquired');
                }), '取消后重取');
                assert(again === 'reacquired', '取消后锁无法重新取得');
                return {
                    name,
                    queuedObserved: true,
                    queuedExecuteCalls: queuedCalls,
                    abortError: 'AbortError',
                    reacquired: true,
                    scope: 'raw Web Locks API queue; production helper has no queue signal option'
                };
            } finally {
                controller.abort();
                hold.resolve();
                await bounded(owner, 'API queue 清理');
            }
        }, value => value);

        await evidence.check(`${PREFIX}真实音频批次前缀同名排他与释放`, async () => {
            const name = `momoki.audio-batch.native-lock-probe-${crypto.randomUUID()}`, entered = gate(),
                hold = heldGate();
            let conflictCalls = 0;
            const owner = observe(locks.request(name, {ifAvailable: true}, async lock => {
                assert(lock, '音频前缀首次 owner 失败');
                entered.resolve();
                await hold.promise;
            }));
            try {
                await bounded(entered.promise, '音频前缀 owner 进入');
                const available = await bounded(locks.request(name, {ifAvailable: true}, lock => {
                    if (lock) conflictCalls++;
                    return Promise.resolve(!!lock);
                }), '音频同名竞争');
                assert(!available && conflictCalls === 0, '同名音频批次同时取得锁');
                hold.resolve();
                await bounded(owner, '音频前缀 owner 释放');
                const again = await bounded(locks.request(name, {ifAvailable: true}, lock => Promise.resolve(!!lock)), '音频前缀释放后重取');
                assert(again, '音频前缀释放后无法重新取得锁');
                return {
                    name,
                    conflictExecuteCalls: conflictCalls,
                    reacquired: true,
                    scope: 'real API using unchanged audio batch lock-name contract; no generation dispatch'
                };
            } finally {
                hold.resolve();
                await bounded(owner, '音频前缀清理');
            }
        }, value => value);
    } finally {
        for (const controller of controllers) controller.abort();
        for (const release of releases) release();
        await evidence.check(`${PREFIX}探针所有 owner 清理`, async () => {
            const outcomes = await bounded(Promise.allSettled([...pending]), '探针清理');
            assert(pending.size === 0, '仍有未结束的锁请求');
            return {
                pendingRequests: pending.size,
                settled: outcomes.length,
                allHoldGatesReleased: true,
                allQueueControllersAborted: true
            };
        }, value => value);
        const events = evidence.events.slice(firstEvent);
        const passed = events.length === 7 && events.every(event => event.ok);
        evidence.record(`${PREFIX}独立探针完成`, passed, {
            passed,
            checks: events.length,
            wholeProductAcceptanceComplete: false,
            wholeHistoricalAcceptanceComplete: false,
            paidRequests: 0
        });
    }
}
