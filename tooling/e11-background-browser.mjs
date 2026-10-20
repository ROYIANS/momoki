import assert from "node:assert/strict";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createServer} from "vite";
import react from "@vitejs/plugin-react";
import ts from "typescript";
import tailwindcss from "@tailwindcss/vite";
import {prepareNativeFixture} from "./native-fixture-ready.mjs";
const {chromium} = await import(process.env.E11_PLAYWRIGHT_PATH ?? "playwright");
const cacheDir = await mkdtemp(join(tmpdir(), "e11-vite-"));
const output = process.env.E11_EVIDENCE_DIR ?? await mkdtemp(join(tmpdir(), "e11-browser-"));
const fixture = "/tests/fixtures/e11-background/";
const server = await createServer({configFile: false, cacheDir, publicDir: fileURLToPath(new URL("../packages/distribution/public", import.meta.url)),
    plugins: [{name: "e11-function-render-counts", enforce: "pre", transform(code, id) {
        if (id.endsWith("/platform/product/queries.ts")) return code.replace("if (active) setState(previous => ({", "if (active) (globalThis as {__e11ReadError?: (value: string) => void}).__e11ReadError?.(queryRef.current.toString());\n                if (active) setState(previous => ({");
        const names = id.endsWith("/app/layout/AppFrame.tsx") ? ["AppFrame"] :
            id.endsWith("/agent/ui/AgentChatPage.tsx") ? ["AgentChatInner"] :
            id.endsWith("/agent/ui/ChatWorkspace.tsx") ? ["ChatWorkspace"] :
            id.endsWith("/agent/ui/FloatingComposer.tsx") ? ["FloatingComposer"] :
            id.endsWith("/agent/ui/TopicSidebar.tsx") ? ["TopicListBody", "TopicRow"] : [];
        if (!names.length) return;
        const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const insertions = [];
        const visit = node => {
            if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name && names.includes(node.name.text) && node.body) {
                insertions.push({position: node.body.getStart(source) + 1, name: node.name.text});
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        assert.equal(insertions.length, names.length, `Render counter discovery: ${id}`);
        for (const {position, name} of insertions.sort((a, b) => b.position - a.position)) {
            code = code.slice(0, position) + `\n    (globalThis as {__e11Render?: (name: string) => void}).__e11Render?.("${name}");` + code.slice(position);
        }
        return names.length ? code : undefined;
    }}, {name: "e11-held-creation", enforce: "pre", transform(code, id) {
        if (!id.endsWith("/features/agent/commands/chat.ts")) return;
        return code.replace("    const db = store ?? productDb;", "    await (globalThis as {__e11BeforeCreate?: () => Promise<void>}).__e11BeforeCreate?.();\n    const db = store ?? productDb;");
    }}, react(), tailwindcss()], optimizeDeps: {holdUntilCrawlEnd: false, entries: [fileURLToPath(new URL(`..${fixture}index.html`, import.meta.url))]},
    resolve: {alias: {"@": fileURLToPath(new URL("../packages/studio/src", import.meta.url))}},
    server: {host: "127.0.0.1", port: 0, hmr: false, watch: {ignored: ["**/.trellis/**"]}}});
const errors = [], checks = [], measurements = {};
let browser, page;
try {
    await server.listen(); await prepareNativeFixture(server, `${fixture}harness.tsx`);
    browser = await chromium.launch({headless: true, ...(process.env.E11_CHROMIUM_PATH ? {executablePath: process.env.E11_CHROMIUM_PATH} : {})});
    page = await browser.newPage({viewport: {width: 1440, height: 900}}); page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    const origin = server.resolvedUrls.local[0];
    await page.route("**/*", route => route.request().url().startsWith(origin) || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort());
    await page.goto(origin + fixture.slice(1)); await page.waitForFunction(() => Boolean(window.e11));
    const ids = await page.evaluate(() => ({a: window.e11.a.id, b: window.e11.b.id, c: window.e11.c.id, p: window.e11.project.id}));
    const composer = () => page.getByRole("textbox", {name: "消息内容", exact: true});
    const go = to => page.evaluate(to => window.e11.navigate(to), to);
    const test = async (name, run) => {await run(); assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.e11.errors), []); checks.push(name); console.log(`PASS ${name}`);};
    const checkBusyGeometry = async () => {
        const row = page.locator(`[data-thread-id="${ids.b}"]`);
        await row.locator('.agent-topic-row-status[data-marker="running"] .agent-dot-matrix').waitFor({state: "visible"});
        await page.emulateMedia({reducedMotion: "reduce"});
        const geometry = () => row.evaluate(element => {
            const rect = selector => {const value = element.querySelector(selector).getBoundingClientRect(); return {left: value.left, right: value.right, width: value.width, height: value.height};};
            return {row: {left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, height: element.getBoundingClientRect().height},
                marker: rect(".agent-topic-row-status"), trailing: rect(".agent-topic-row-trailing"),
                title: rect(".agent-topic-row-title"), time: rect("time"), actions: rect(".agent-topic-row-actions")};
        });
        const assertOrder = value => {assert.ok(value.marker.right <= value.title.left, JSON.stringify(value));
            assert.ok(value.title.right <= value.trailing.left); assert.equal(value.marker.width, 16); assert.equal(value.row.height, 32);};
        const before = await geometry(); assertOrder(before);
        await row.hover(); const hovered = await geometry(); assertOrder(hovered); assert.equal(hovered.marker.right, before.marker.right);
        await row.getByRole("button", {name: "重命名", exact: true}).focus();
        const focused = await geometry(); assertOrder(focused); assert.equal(focused.marker.right, before.marker.right);
        await page.screenshot({path: join(output, "sidebar-wide.png")});
        await page.setViewportSize({width: 650, height: 900});
        const topicOpener = page.getByRole("button", {name: "展开模块导航", exact: true});
        await topicOpener.click(); await row.waitFor({state: "visible"});
        const narrow = await geometry(); assertOrder(narrow);
        await row.getByRole("button", {name: "删除", exact: true}).focus();
        assert.equal((await geometry()).marker.right, narrow.marker.right);
        await page.screenshot({path: join(output, "sidebar-narrow.png")});
        measurements.sidebarGeometry = {before, hovered, focused, narrow};
        await page.keyboard.press("Escape"); await page.setViewportSize({width: 1440, height: 900});
        await page.emulateMedia({reducedMotion: "no-preference"});
        await composer().focus();
    };
    await test("optimistic message paints before preparation; A original request stays live", async () => {
        await composer().fill("E11 payload A");
        await page.getByRole("button", {name: "发送", exact: true}).click();
        await page.getByText("E11 payload A", {exact: true}).waitFor();
        await page.waitForFunction(() => window.e11.requests.length === 1);
        assert.equal(await page.evaluate(() => window.e11.requests[0].optimisticVisible), true);
        await composer().fill("Unsent A draft");
    });
    await test("A and B independent requests survive real settings/project and history navigation", async () => {
        await go(`/agent/${ids.b}`); await composer().fill("E11 payload B"); await page.getByRole("button", {name: "发送", exact: true}).click();
        await page.waitForFunction(() => window.e11.requests.length === 2); await composer().fill("Unsent B draft");
        await go("/settings"); await page.getByRole("heading", {name: "通用", exact: true}).waitFor();
        await go(`/p/${ids.p}`); await page.goBack(); await page.goBack(); await composer().waitFor();
        assert.equal(await composer().inputValue(), "Unsent B draft");
        await page.goForward(); await page.goForward();
        await page.evaluate(() => {window.e11.emit(0, "A while detached"); window.e11.emit(1, "B while detached");});
        await page.waitForFunction(() => window.e11.db.chatMessages.toArray().then(rows => rows.some(row => row.content.includes("A while detached")) && rows.some(row => row.content.includes("B while detached"))));
        const requests = await page.evaluate(() => window.e11.requests.map(request => ({aborted: request.aborted})));
        assert.deepEqual(requests, [{aborted: false}, {aborted: false}]);
        await go(`/agent/${ids.a}`); assert.equal(await composer().inputValue(), "Unsent A draft");
        assert.equal(await page.getByRole("alertdialog").count(), 0);
    });
    await test("actual busy row keeps a fixed 16px leading marker cell through wide/narrow hover and keyboard focus", checkBusyGeometry);
    await test("A/B switching retains exact sidebar DOM and search while B transcript delivery is held", async () => {
        await page.evaluate(() => {window.__e11Sidebar = document.querySelector(".agent-topic-sidebar"); window.__e11Rows = [...document.querySelectorAll(".agent-topic-row")];});
        await page.getByRole("button", {name: "搜索", exact: true}).click();
        await page.getByRole("searchbox", {name: "搜索话题标题", exact: true}).fill("E11");
        await page.evaluate(id => window.e11.holdTranscript(id), ids.b);
        await go(`/agent/${ids.b}`); await composer().waitFor();
        assert.equal(await page.evaluate(() => document.querySelector(".agent-topic-sidebar") === window.__e11Sidebar), true);
        assert.equal(await page.getByRole("searchbox", {name: "搜索话题标题", exact: true}).inputValue(), "E11");
        assert.equal(await page.evaluate(() => window.__e11Rows.every(row => row.isConnected)), true);
        assert.equal(await page.getByText(/Render warmup/).count(), 0);
        await page.evaluate(() => window.e11.releaseTranscript());
        await page.getByText(/B while detached/).first().waitFor();
        await go(`/agent/${ids.a}`); await composer().waitFor();
        assert.equal(await page.evaluate(() => document.querySelector(".agent-topic-sidebar") === window.__e11Sidebar), true);
        await page.getByRole("button", {name: "关闭搜索", exact: true}).click();
    });
    await test("real streaming checkpoints and metrics change text without page/composer/sidebar function renders", async () => {
        await page.evaluate(() => window.e11.emit(0, " Render warmup."));
        await page.getByText(/Render warmup/).first().waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const before = await page.evaluate(() => ({...window.e11.renders}));
        for (const name of ["AppFrame", "AgentChatInner", "ChatWorkspace", "FloatingComposer", "TopicListBody", "TopicRow"]) assert.ok(before[name] > 0, `actual function counter ${name}`);
        for (let index = 1; index <= 4; index++) {
            await page.evaluate(index => window.e11.emit(0, ` Checkpoint ${index}.`), index);
            await page.getByText(new RegExp(`Checkpoint ${index}`)).first().waitFor();
        }
        await page.evaluate(threadId => window.e11.metrics(threadId), ids.a);
        await page.waitForFunction(id => window.e11.db.agentRuns.where("threadId").equals(id).toArray().then(rows => rows.some(run => run.usage?.totalTokens === 30)), ids.a);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const after = await page.evaluate(() => ({...window.e11.renders}));
        assert.deepEqual(after, before);
        measurements.renderCounts = {before, after};
        measurements.executionTimings = await page.evaluate(() => performance.getEntriesByType("measure").filter(entry => entry.name.includes("agent")).map(entry => ({name: entry.name, durationMs: entry.duration})));
    });
    await test("Stop A leaves B live and reattachment does not dispatch", async () => {
        await page.getByRole("button", {name: "停止", exact: true}).last().click();
        await page.waitForFunction(() => window.e11.requests[0].aborted);
        await go(`/agent/${ids.b}`); await composer().waitFor();
        assert.equal(await composer().inputValue(), "Unsent B draft");
        await page.evaluate(() => window.e11.emit(1, "B survives A Stop"));
        await page.getByText(/B survives A Stop/).first().waitFor();
        assert.deepEqual(await page.evaluate(() => window.e11.requests.map(request => request.aborted)), [true, false]);
        await page.evaluate(() => window.e11.finish(1));
    });
    await test("production Agent-owned generation worker continues after its view unmounts", async () => {
        const batch = await page.evaluate(() => window.e11.prepareBatch());
        await go("/batch"); await page.getByRole("button", {name: "打开批量生成：E11 real batch", exact: true}).click();
        await page.getByRole("button", {name: "继续处理", exact: true}).click();
        await page.waitForFunction(() => window.e11.generation.some(request => request.method === "GET"));
        await go("/settings"); await go(`/agent/${ids.c}`); await composer().waitFor();
        assert.deepEqual(await page.evaluate(id => window.e11.execution(id), ids.c), {active: true, kind: "videoBatch"});
        await page.getByRole("button", {name: "停止", exact: true}).last().waitFor();
        assert.equal(await page.getByRole("alertdialog").count(), 0);
        assert.equal(await page.evaluate(() => window.e11.generation.filter(request => request.method === "POST").length), 1);
        assert.equal(await page.evaluate(() => window.e11.generation.some(request => request.aborted)), false);
        await page.evaluate(() => window.e11.releaseGeneration());
        await page.waitForFunction(batch => window.e11.db.agentGenerationJobs.where("batchId").equals(batch).toArray().then(rows => rows.some(row => row.status === "downloaded")), batch);
        await go("/batch");
        assert.equal(await page.evaluate(() => window.e11.generation.filter(request => request.method === "POST").length), 1);
    });
    await test("late home creation keeps the same mounted task board and its later draft", async () => {
        await go(`/agent/${ids.a}`); await composer().waitFor(); await go("/agent"); await composer().waitFor();
        await page.evaluate(() => window.e11.holdCreation());
        await composer().fill("Delayed home payload"); await page.getByRole("button", {name: "发送", exact: true}).click();
        await page.waitForFunction(() => window.e11.creationEntered());
        await go("/agent/tasks");
        await page.evaluate(() => window.e11.releaseCreation());
        await page.waitForFunction(() => window.e11.requests.length === 3);
        assert.equal(await page.evaluate(() => window.e11.route()), "/agent/tasks");
        await go(`/agent/${ids.b}`); await composer().fill("B untouched by late home receipt");
        await page.evaluate(() => window.e11.finish(2));
        await go("/agent/tasks"); await go(`/agent/${ids.b}`); await composer().waitFor();
        assert.equal(await composer().inputValue(), "B untouched by late home receipt");
        assert.equal(await page.evaluate(() => window.e11.requests.length), 3);
    });
    await test("saved approval attaches quietly and only an explicit decision authorizes continuation", async () => {
        const approval = await page.evaluate(() => window.e11.prepareApproval());
        await go(`/agent/${approval.threadId}`); await page.getByRole("button", {name: "批准", exact: true}).waitFor();
        assert.equal(await page.evaluate(() => window.e11.requests.length), 3);
        await go("/settings"); await go(`/agent/${approval.threadId}`);
        assert.equal(await page.evaluate(() => window.e11.requests.length), 3);
        await page.getByRole("button", {name: "拒绝", exact: true}).click();
        await page.waitForFunction(id => window.e11.db.agentToolCalls.get(id).then(call => call?.status === "rejected"), approval.callId);
        await page.waitForFunction(() => window.e11.requests.length === 4);
        await go("/settings"); assert.equal(await page.evaluate(() => window.e11.requests[3].aborted), false);
        await page.evaluate(() => window.e11.finish(3));
    });
    await test("populated real transcript and mounted context gauge expose original send/request/receipt/DOM timings", async () => {
        const history = await page.evaluate(() => window.e11.preparePopulatedThread());
        await go(`/agent/${history.threadId}`); await composer().waitFor();
        await page.getByRole("button", {name: "上下文明细", exact: true}).waitFor();
        await page.getByText(/Previous creative discussion/).first().waitFor();
        const baseline = await page.evaluate(() => ({requests: window.e11.requests.length, preflights: window.e11.preflightRequests(),
            marks: performance.getEntriesByType("mark").filter(entry => entry.name.startsWith("momoki.agent.")).map(entry => entry.name)}));
        await composer().fill("E11 populated timing request");
        await page.getByRole("button", {name: "发送", exact: true}).click();
        await page.waitForFunction(count => window.e11.requests.length === count + 1, baseline.requests);
        await page.getByText(/Original live answer/).first().waitFor();
        await page.waitForFunction(oldMarks => performance.getEntriesByType("mark").some(entry => entry.name.endsWith(".firstPublicCommitted") && !oldMarks.includes(entry.name)), baseline.marks);
        measurements.populatedSend = await page.evaluate(({history, baseline}) => {
            const marks = performance.getEntriesByType("mark").filter(entry => entry.name.startsWith("momoki.agent.") && !baseline.marks.includes(entry.name));
            const at = ending => marks.find(entry => entry.name.endsWith(`.${ending}`))?.startTime;
            const elapsed = (from, to) => at(from) === undefined || at(to) === undefined ? null : at(to) - at(from);
            return {history, modelPreflightGets: window.e11.preflightRequests() - baseline.preflights,
                submissionToRequestMs: elapsed("submitted", "requestInvoked"), requestToReceiptMs: elapsed("requestInvoked", "firstPublicReceived"),
                receiptToCheckpointMs: elapsed("firstPublicReceived", "firstCheckpointConfirmed"), receiptToDomMs: elapsed("firstPublicReceived", "firstPublicCommitted"),
                submissionToDomMs: elapsed("submitted", "firstPublicCommitted"), marks: marks.map(entry => ({name: entry.name, at: entry.startTime}))};
        }, {history, baseline});
        assert.equal(measurements.populatedSend.modelPreflightGets, 0);
        assert.ok(measurements.populatedSend.submissionToDomMs !== null);
        await page.evaluate(index => window.e11.finish(index), baseline.requests);
    });
    await test("explicit Quit includes pending route:false editor overlays and cancel keeps admission open", async () => {
        await go("/manual-overlay"); await page.getByText("Retained local editor", {exact: true}).waitFor();
        await page.evaluate(() => window.e11.quit.emit("checking_drafts", "overlay-quit"));
        await page.getByRole("alertdialog").waitFor();
        await page.getByText("正在处理修改", {exact: true}).waitFor();
        assert.equal(await page.getByRole("button", {name: "放弃并离开", exact: true}).count(), 0);
        await page.getByRole("button", {name: "继续编辑", exact: true}).click();
        await page.waitForFunction(() => window.e11.quit.actions.some(action => action.kind === "guardDecision" && action.intentId === "overlay-quit" && action.decision === "cancel"));
        assert.equal(await page.evaluate(() => window.e11.quit.admissionOpen()), true);
        await page.evaluate(() => {window.e11.quit.emit("running", null); window.e11.setOverlayPending(false);});
    });
    await test("AI wrapup continues detached while manual summary edits keep their real departure guard", async () => {
        await go("/wrapup"); await page.getByRole("button", {name: "AI 整理总结", exact: true}).click();
        await page.waitForFunction(() => window.e11.wrapup.requests === 1); await go("/settings");
        assert.equal(await page.getByRole("alertdialog").count(), 0);
        assert.equal(await page.evaluate(() => window.e11.wrapup.aborted), false);
        await page.evaluate(() => window.e11.wrapup.release());
        await page.waitForFunction(() => window.e11.db.agentTaskWrapups.where("taskId").equals(window.e11.wrapupTask.id).toArray().then(rows => rows.some(row => row.status === "draft")));
        await go("/wrapup"); await page.getByText("E11 retained AI summary", {exact: true}).waitFor();
        await page.getByRole("button", {name: "编辑", exact: true}).click();
        await page.getByRole("textbox", {name: "总结", exact: true}).fill("Manual edits remain protected");
        await page.evaluate(() => {void window.e11.navigate("/settings");}); await page.getByRole("alertdialog").waitFor();
        await page.getByRole("button", {name: "继续编辑", exact: true}).click();
        assert.equal(await page.getByRole("textbox", {name: "总结", exact: true}).inputValue(), "Manual edits remain protected");
        assert.equal(await page.evaluate(() => window.e11.wrapup.requests), 1);
    });
    await test("application Quit reuses the mounted manual guard, cancellation keeps work eligible, discard admits one original drain", async () => {
        assert.equal(await page.evaluate(() => window.e11.quit.needsDecision()), true);
        await page.evaluate(() => window.e11.quit.emit("checking_drafts", "browser-quit-1"));
        await page.getByRole("alertdialog").waitFor();
        assert.equal(await page.getByRole("alertdialog").count(), 1);
        await page.getByRole("button", {name: "继续编辑", exact: true}).click();
        await page.waitForFunction(() => window.e11.quit.actions.some(action => action.kind === "guardDecision" && action.decision === "cancel"));
        assert.equal(await page.evaluate(() => window.e11.quit.admissionOpen()), true);
        assert.equal(await page.getByRole("textbox", {name: "总结", exact: true}).inputValue(), "Manual edits remain protected");
        await page.evaluate(() => {window.e11.quit.emit("running", null); window.e11.quit.emit("checking_drafts", "browser-quit-2");});
        await page.getByRole("alertdialog").waitFor();
        await page.getByRole("button", {name: "放弃并离开", exact: true}).click();
        await page.waitForFunction(() => window.e11.quit.actions.some(action => action.kind === "guardDecision" && action.intentId === "browser-quit-2" && action.decision === "proceed"));
        await page.getByRole("alertdialog").waitFor({state: "hidden"});
        assert.equal(await page.getByRole("alertdialog").count(), 0);
        await page.evaluate(async () => {window.e11.quit.emit("quiescing", "browser-quit-2"); window.e11.quit.emit("quiescing", "browser-quit-2"); await window.e11.quit.done();});
        assert.equal(await page.evaluate(() => window.e11.quit.admissionOpen()), false);
        assert.equal(await page.evaluate(() => window.e11.quit.actions.filter(action => action.kind === "drained").length), 1);
    });
    await writeFile(join(output, "result.json"), JSON.stringify({status: "PASS", checks, errors, measurements, browser: browser.version(),
        limits: "Actual routed Agent/Settings/Project UI, IndexedDB and generation runtime; controlled local HTTP only. Chromium fixture does not establish packaged/native hidden scheduling."}, null, 2));
    console.log(`E11 evidence: ${output}`);
} catch (cause) {
    if (page) {await page.screenshot({path: join(output, "failure.png"), fullPage: true}); await writeFile(join(output, "failure.html"), await page.content());}
    await writeFile(join(output, "result.json"), JSON.stringify({status: "FAIL", checks, errors, error: String(cause), fixtureErrors: page ? await page.evaluate(() => ({errors: window.e11?.errors, readErrors: window.e11?.readErrors})).catch(() => []) : []}, null, 2));
    console.error(`E11 evidence: ${output}`); throw cause;
} finally {await browser?.close(); await server.close(); await rm(cacheDir, {recursive: true, force: true});}
