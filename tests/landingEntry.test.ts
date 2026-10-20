// @vitest-environment jsdom
import {act, createElement} from "react";
import {createRoot, type Root} from "react-dom/client";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {GITHUB_URL, STUDIO_URL} from "@momoki/distribution/brand";
import {Landing} from "../apps/site/src/Landing";
import {SCENE_COPY} from "../apps/site/src/content/copy";
import {FORBIDDEN_CLAIMS} from "./fixtures/landing/forbiddenClaims";


const html = readFileSync(resolve(process.cwd(), "apps/site/landing.html"), "utf8");
const documentFromHtml = new DOMParser().parseFromString(html, "text/html");
const compact = (text: string | null) => (text ?? "").replace(/\s+/g, "");

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // Never resolves: the first render (loading state) is what must match landing.html, and no real request is made.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    // No 2D canvas (as in jsdom): the page renders its static, readable mode, which landing.html mirrors.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Landing)));
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("landing page content", () => {
    it("links to the app, the releases page and GitHub", () => {
        const link = (name: string) => [...container.querySelectorAll("a")].find(a => a.textContent === name);
        expect(link("进入应用")?.getAttribute("href")).toBe("/agent");
        expect(link("在浏览器中体验")?.getAttribute("href")).toBe("/agent");
        expect(link("下载桌面版")?.getAttribute("href")).toBe("#download");
        expect(container.querySelectorAll("section[data-scene]")).toHaveLength(7);
        expect(link("在 GitHub 查看所有版本")?.getAttribute("href")).toBe(`${GITHUB_URL}/releases`);
        expect(link("GitHub")?.getAttribute("href")).toBe(GITHUB_URL);
        expect(container.querySelector("h1")?.textContent).toBe("默默 Momoki");
    });

    it("declares every external link and uses no remote images", () => {
        for (const a of container.querySelectorAll("a[href^='http']")) {
            expect([GITHUB_URL, STUDIO_URL].some(base => a.getAttribute("href")!.startsWith(base))).toBe(true);
            expect(a.getAttribute("rel")).toContain("noopener");
        }
        for (const img of container.querySelectorAll("img")) expect(img.getAttribute("src")).toMatch(/^\/brand\//);
    });

    it("makes no unsupported claims", () => {
        const text = [container.textContent ?? "", documentFromHtml.body.textContent ?? "", html].join("\n");
        expect(FORBIDDEN_CLAIMS.filter(claim => text.includes(claim))).toEqual([]);
    });
});

describe("apps/site/landing.html", () => {
    it("holds static content identical to the React render, so a script failure still shows the page", () => {
        const staticRoot = documentFromHtml.getElementById("root");
        expect(compact(staticRoot?.textContent ?? null)).toBe(compact(container.textContent));
        const hrefs = (scope: ParentNode) => [...scope.querySelectorAll("a")].map(a => a.getAttribute("href"));
        expect(hrefs(staticRoot!)).toEqual(hrefs(container));
    });

    it("has SEO metadata and no application styles or scripts", () => {
        const meta = (selector: string) => documentFromHtml.querySelector(selector)?.getAttribute("content") ?? documentFromHtml.querySelector(selector)?.getAttribute("href");
        expect(documentFromHtml.documentElement.lang).toBe("zh-CN");
        expect(meta("link[rel=canonical]")).toBe("https://cue.vidorra.life/");
        expect(meta("meta[name=theme-color]")).toBe("#101010");
        expect(meta("meta[name=description]")).toBeTruthy();
        expect(meta("meta[property='og:image']")).toMatch(/^https:\/\/cue\.vidorra\.life\/brand\/og-card\.png/);
        expect(meta("meta[name='twitter:card']")).toBe("summary_large_image");
        const ld = JSON.parse(documentFromHtml.querySelector("script[type='application/ld+json']")!.textContent!) as Record<string, unknown>;
        expect(ld["@type"]).toBe("SoftwareApplication");
        expect(ld.downloadUrl).toBe(`${GITHUB_URL}/releases`);
        expect(JSON.stringify(ld)).not.toMatch(/\d+\.\d+\.\d+/);
        expect(html).not.toContain("styles.css");
        expect([...documentFromHtml.querySelectorAll("script[src]")].map(s => s.getAttribute("src"))).toEqual(["/src/main.tsx"]);
    });

    it("subsets the display font and falls back without blocking", () => {
        const href = documentFromHtml.querySelector("link[href*='fonts.googleapis.com/css2']")!.getAttribute("href")!;
        expect(href).toContain("display=swap");
        expect(decodeURIComponent(href)).toContain("text=默默 Momoki");
        const text = decodeURIComponent(href).split("text=")[1];
        for (const scene of Object.values(SCENE_COPY)) for (const ch of scene.subtitle.text) expect(text, `subtitle character ${ch}`).toContain(ch); // the subtitles are set in the display font too
    });
});
