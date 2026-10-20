// @vitest-environment jsdom
import {act, createElement, useRef} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {GITHUB_URL} from "@momoki/distribution/brand";
import {Landing} from "../apps/site/src/Landing";
import {SCENE_COPY} from "../apps/site/src/content/copy";
import {resolveFilmMode, readSkipPreference, writeSkipPreference, SKIP_FILM_KEY} from "../apps/site/src/film/mode";
import {SCENES, STAGE_SCENES, TOTAL_WEIGHT} from "../apps/site/src/film/scenes";
import {frameToTimecode, progressToFrame, sceneProgressWindow} from "../apps/site/src/film/timeline";
import {FILM_PLAY_SECONDS, progressToPlaybackTime} from "../apps/site/src/film/playback";
import {toneCss} from "../apps/site/src/film/tone";
import {createFilmDriver, useFilmProgress, type FilmDriverEnv, type FilmState} from "../apps/site/src/film/useFilmProgress";

describe("scenes", () => {
    it("has seven scenes with the credits as the last, flow scene excluded from the stage total", () => {
        expect(SCENES.map(scene => scene.id)).toEqual(["leader", "spark", "script", "agent", "vault", "delivery", "credits"]);
        expect(SCENES.map(scene => scene.weight)).toEqual([1.1, 1, 1.2, 1.2, 1, 1, 0]);
        expect(SCENES[6].flow).toBe(true);
        expect(STAGE_SCENES).toHaveLength(6);
        expect(TOTAL_WEIGHT).toBeCloseTo(6.5, 10);
    });
});

describe("timeline", () => {
    it("clamps progress and treats non-finite input as 0", () => {
        expect(progressToFrame(0)).toEqual({sceneIndex: 0, local: 0, progress: 0});
        expect(progressToFrame(1)).toEqual({sceneIndex: 5, local: 1, progress: 1});
        for (const bad of [-1, -0.0001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            expect(progressToFrame(bad)).toEqual({sceneIndex: 0, local: 0, progress: 0});
        }
        expect(progressToFrame(7)).toEqual({sceneIndex: 5, local: 1, progress: 1});
    });

    it("gives a boundary to the following scene and the previous scene the instant before it", () => {
        for (let index = 1; index < STAGE_SCENES.length; index += 1) {
            const {start} = sceneProgressWindow(index);
            expect(progressToFrame(start)).toMatchObject({sceneIndex: index, local: 0});
            expect(progressToFrame(start - 1e-9).sceneIndex).toBe(index - 1);
            const {start: s, end} = sceneProgressWindow(index);
            expect(progressToFrame((s + end) / 2)).toMatchObject({sceneIndex: index});
            expect(progressToFrame((s + end) / 2).local).toBeCloseTo(0.5, 6);
        }
    });

    it("builds contiguous windows from the cumulative weights", () => {
        let cursor = 0;
        STAGE_SCENES.forEach((scene, index) => {
            const {start, end} = sceneProgressWindow(index);
            expect(start).toBeCloseTo(cursor, 10);
            expect(end - start).toBeCloseTo(scene.weight / TOTAL_WEIGHT, 10);
            cursor = end;
        });
        expect(sceneProgressWindow(5).end).toBe(1);
        expect(sceneProgressWindow(0).start).toBe(0);
        for (const bad of [6, -1, 1.5, Number.NaN]) expect(sceneProgressWindow(bad)).toEqual({start: 1, end: 1});
    });

    it("formats the timecode as HH:MM:SS:FF and returns zeros for invalid input", () => {
        expect(frameToTimecode(0, 96)).toBe("00:00:00:00");
        expect(frameToTimecode(0.5, 96)).toBe("00:00:48:00");
        expect(frameToTimecode(1, 96)).toBe("00:01:36:00");
        expect(frameToTimecode(1.5 / 96, 96)).toBe("00:00:01:12");
        expect(frameToTimecode(1, 7200)).toBe("02:00:00:00");
        expect(frameToTimecode(0.5, 10, 25)).toBe("00:00:05:00");
        expect(frameToTimecode(2, 96)).toBe("00:01:36:00");
        expect(frameToTimecode(-1, 96)).toBe("00:00:00:00");
        for (const [p, t, f] of [[Number.NaN, 96, 24], [Number.POSITIVE_INFINITY, 96, 24], [0.5, 0, 24], [0.5, -3, 24], [0.5, Number.NaN, 24], [0.5, 96, 0], [0.5, 96, 2.5]] as const) {
            expect(frameToTimecode(p, t, f)).toBe("00:00:00:00");
        }
    });
});

describe("film mode", () => {
    it("is static for reduced motion, a skip choice or a missing canvas, and film otherwise", () => {
        for (const reducedMotion of [false, true]) for (const skipped of [false, true]) for (const canvas2d of [false, true]) {
            const expected = !reducedMotion && !skipped && canvas2d ? "film" : "static";
            expect(resolveFilmMode({reducedMotion, skipped, canvas2d})).toBe(expected);
        }
    });

    it("remembers the skip choice and survives storage failures", () => {
        const data = new Map<string, string>();
        const storage = {getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key)};
        expect(SKIP_FILM_KEY).toBe("momoki.landing.skipFilm");
        expect(readSkipPreference(storage)).toBe(false);
        writeSkipPreference(true, storage);
        expect(readSkipPreference(storage)).toBe(true);
        writeSkipPreference(false, storage);
        expect(readSkipPreference(storage)).toBe(false);
        const broken = {getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); }};
        expect(readSkipPreference(broken)).toBe(false);
        expect(() => writeSkipPreference(true, broken)).not.toThrow();
        expect(readSkipPreference(undefined)).toBe(false);
    });
});

function driverHarness(initialTarget = 0) {
    let time = 1000;
    let nextId = 0;
    let hidden = false;
    let target = initialTarget;
    const queue = new Map<number, (time: number) => void>();
    const handlers: {scroll?: () => void; visible?: () => void} = {};
    const removed = vi.fn();
    const read = vi.fn(() => target);
    const states: FilmState[] = [];
    const write = vi.fn((state: FilmState) => void states.push(state));
    const env: Partial<FilmDriverEnv> = {
        raf: callback => { nextId += 1; queue.set(nextId, callback); return nextId; },
        caf: id => void queue.delete(id),
        now: () => time,
        isHidden: () => hidden,
        listen: (scroll, visible) => { handlers.scroll = scroll; handlers.visible = visible; return removed; },
    };
    const driver = createFilmDriver({read, write, env});
    return {
        driver, queue, states, read, write, removed, handlers,
        setTarget: (value: number) => { target = value; },
        setHidden: (value: boolean) => { hidden = value; },
        frame(ms = 16) {
            time += ms;
            const callbacks = [...queue.values()];
            queue.clear();
            for (const callback of callbacks) callback(time);
        },
    };
}

describe("createFilmDriver", () => {
    it("paints the first frame exactly and schedules nothing while idle", () => {
        const h = driverHarness(0.4);
        h.driver.start();
        expect(h.states).toHaveLength(1);
        expect(h.states[0].progress).toBeCloseTo(0.4, 10);
        expect(h.queue.size).toBe(0);
    });

    it("eases toward the target, keeps one frame queued per scroll burst and stops when settled", () => {
        const h = driverHarness(0);
        h.driver.start();
        h.setTarget(0.8);
        h.handlers.scroll!();
        h.handlers.scroll!();
        h.handlers.scroll!();
        expect(h.queue.size).toBe(1);
        const readsBefore = h.read.mock.calls.length;
        h.frame();
        expect(h.read.mock.calls.length - readsBefore).toBe(1);
        const first = h.states.at(-1)!.progress;
        expect(first).toBeGreaterThan(0);
        expect(first).toBeLessThan(0.8);
        expect(first).toBeCloseTo(0.8 * (1 - Math.exp(-16 / 80)), 6); // one step of the exponential ease
        let frames = 1;
        while (h.queue.size > 0 && frames < 400) { h.frame(); frames += 1; }
        expect(h.states.at(-1)!.progress).toBe(0.8);
        expect(frames).toBeLessThan(120);
        expect(h.queue.size).toBe(0); // settled: no more frames are requested
        expect(h.read.mock.calls.length - readsBefore).toBe(1); // read once, not every frame
        const progress = h.states.map(state => state.progress);
        expect(progress).toEqual([...progress].sort((a, b) => a - b));
        h.frame();
        expect(h.write.mock.calls.length).toBe(h.states.length); // a stray extra frame writes nothing
    });

    it("writes once per frame and notifies subscribers, including once on subscribe", () => {
        const h = driverHarness(0);
        h.driver.start();
        const seen: FilmState[] = [];
        const off = h.driver.subscribe(state => seen.push(state));
        expect(seen).toHaveLength(1);
        h.setTarget(1);
        h.handlers.scroll!();
        const writes = h.write.mock.calls.length;
        h.frame();
        expect(h.write.mock.calls.length - writes).toBe(1);
        expect(seen).toHaveLength(2);
        off();
        h.frame();
        expect(seen).toHaveLength(2);
    });

    it("cancels its frame while the document is hidden and resumes when visible", () => {
        const h = driverHarness(0);
        h.driver.start();
        h.setTarget(1);
        h.handlers.scroll!();
        expect(h.queue.size).toBe(1);
        h.setHidden(true);
        h.handlers.visible!();
        expect(h.queue.size).toBe(0);
        h.handlers.scroll!();
        expect(h.queue.size).toBe(0);
        h.setHidden(false);
        h.handlers.visible!();
        expect(h.queue.size).toBe(1);
    });

    it("removes listeners and cancels pending frames on stop, and start is idempotent", () => {
        const h = driverHarness(0);
        h.driver.start();
        h.driver.start();
        h.setTarget(1);
        h.handlers.scroll!();
        h.driver.stop();
        expect(h.removed).toHaveBeenCalledTimes(1);
        expect(h.queue.size).toBe(0);
    });
});

describe("DOM", () => {
    let container: HTMLDivElement;
    let root: Root;
    let rafQueue: Map<number, FrameRequestCallback>;
    let clock: number;
    let reduced: boolean;
    let mediaListeners: Set<() => void>;
    let track: {top: number; height: number};
    let setItem: ReturnType<typeof vi.spyOn> | undefined;

    function stubMatchMedia() {
        const query = {
            get matches() { return reduced; },
            addEventListener: (_type: string, listener: () => void) => void mediaListeners.add(listener),
            removeEventListener: (_type: string, listener: () => void) => void mediaListeners.delete(listener),
        };
        vi.stubGlobal("matchMedia", vi.fn(() => query));
    }

    beforeEach(() => {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
        window.scrollTo = vi.fn() as never;
        localStorage.clear();
        reduced = false;
        mediaListeners = new Set();
        track = {top: 0, height: 0};
        rafQueue = new Map();
        let id = 0;
        clock = performance.now();
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { id += 1; rafQueue.set(id, callback); return id; });
        vi.stubGlobal("cancelAnimationFrame", (handle: number) => void rafQueue.delete(handle));
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
            if (this.classList.contains("lp-track")) return {top: track.top, height: track.height, bottom: track.top + track.height, left: 0, right: 0, width: 0, x: 0, y: track.top, toJSON: () => ({})} as DOMRect;
            return {top: 0, height: 0, bottom: 0, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({})} as DOMRect;
        });
        stubMatchMedia();
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        setItem?.mockRestore();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    const renderLanding = () => act(async () => root.render(createElement(Landing)));
    const flushFrames = async () => {
        for (let guard = 0; guard < 400 && rafQueue.size > 0; guard += 1) {
            clock = Math.max(clock, performance.now()) + 16;
            const callbacks = [...rafQueue.values()];
            rafQueue.clear();
            await act(async () => callbacks.forEach(callback => callback(clock)));
        }
    };
    /** Places the viewport at film progress p (track 5200px tall in an 800px window). */
    const scrollTo = async (progress: number) => {
        window.innerHeight = 800;
        track = {top: -progress * 4400, height: 5200};
        await act(async () => window.dispatchEvent(new Event("scroll")));
        await flushFrames();
    };
    const layers = () => [...container.querySelectorAll<HTMLElement>(".lp-layer")];
    const buttonByText = (label: string) => [...container.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === label);
    const setReducedMotion = async (value: boolean) => {
        reduced = value;
        await act(async () => mediaListeners.forEach(listener => listener()));
    };

    describe("film mode", () => {
        it("renders a decorative aria-hidden stage plus a complete screen-reader copy of the six stage scenes", async () => {
            await renderLanding();
            const page = container.querySelector(".lp-page")!;
            expect(page.getAttribute("data-film-mode")).toBe("film");
            const stage = container.querySelector(".lp-stage")!;
            const art = stage.querySelector(".lp-stage-art")!;
            expect(art.getAttribute("aria-hidden")).toBe("true");
            expect(stage.querySelector("canvas[data-film-canvas]")?.getAttribute("aria-hidden")).toBe("true");
            expect(layers()).toHaveLength(6);
            const reading = container.querySelector(".lp-sr-only")!;
            expect(reading.querySelectorAll("section")).toHaveLength(6);
            expect(container.querySelectorAll("h1")).toHaveLength(1);
            for (const scene of STAGE_SCENES) {
                const copy = SCENE_COPY[scene.id];
                expect(reading.textContent).toContain(copy.title);
                expect(reading.textContent).toContain(copy.narration.text);
                expect(reading.textContent).toContain(copy.subtitle.text);
                for (const point of copy.points) expect(reading.textContent).toContain(point.text);
            }
            // The stage is a picture: only the slate label and the subtitle are words; the readable copy carries the rest.
            for (const layer of layers()) {
                const copy = SCENE_COPY[layer.getAttribute("data-scene-layer") as keyof typeof SCENE_COPY];
                expect([...layer.children].map(child => child.textContent)).toEqual([copy.kicker, copy.subtitle.text]);
                expect(layer.querySelector("h1, h2, h3, ul, li, .lp-scene-title, .lp-narration, .lp-points")).toBeNull();
                for (const text of [copy.title, copy.narration.text, ...copy.points.map(point => point.text)]) expect(art.textContent).not.toContain(text);
            }
            expect(art.querySelector("[data-film-look][aria-hidden='true']")).not.toBeNull();
            expect(art.querySelectorAll(".lp-marks [data-mark]")).toHaveLength(2);
            expect(reading.querySelectorAll("a, button")).toHaveLength(0);
            expect(art.querySelectorAll("a, button")).toHaveLength(0);
            expect(container.querySelector(".lp-track")?.getAttribute("style")).toContain("--film-length: 6.5");
        });

        it("follows the scene's ground colour with the film progress, writing it only when it changes", async () => {
            await renderLanding();
            const page = container.querySelector<HTMLElement>(".lp-film")!;
            const set = vi.spyOn(page.style, "setProperty");
            for (const progress of [0, 0.5, 0.97]) {
                await scrollTo(progress);
                expect(page.style.getPropertyValue("--stage-tone")).toBe(toneCss(progress));
            }
            const writes = set.mock.calls.filter(call => call[0] === "--stage-tone").length;
            await scrollTo(0.97);
            expect(set.mock.calls.filter(call => call[0] === "--stage-tone").length).toBe(writes); // same ground: no write
            expect(container.querySelector(".lp-stage")?.getAttribute("style") ?? "").not.toContain("--stage-tone");
        });

        it("makes the skip button the first focusable control and keeps the credits links focusable", async () => {
            await renderLanding();
            const first = container.querySelector("a[href], button, summary");
            expect(first?.tagName).toBe("BUTTON");
            expect(first?.getAttribute("aria-label")).toBe("跳过动画");
            expect(first?.textContent).toBe(""); // icon only
            expect(first?.getAttribute("data-umami-event")).toBe("skip-animation");
            const credits = container.querySelector(".lp-credits")!;
            const hrefs = [...credits.querySelectorAll("a")].map(a => a.getAttribute("href"));
            expect(hrefs).toEqual(expect.arrayContaining(["/agent", "#download", GITHUB_URL, `${GITHUB_URL}/releases`]));
            for (const link of credits.querySelectorAll("a, summary")) {
                expect(link.closest("[inert]")).toBeNull();
                expect(link.closest("[aria-hidden='true']")).toBeNull();
            }
        });

        it("gives both header actions one icon-control component, named by aria-label", async () => {
            await renderLanding();
            const header = container.querySelector(".lp-header")!;
            const controls = [...header.querySelectorAll(".lp-ic")];
            expect(controls).toHaveLength(2);
            const [skip, enter] = controls;
            expect(skip.tagName).toBe("BUTTON");
            expect(skip.getAttribute("aria-label")).toBe("跳过动画");
            expect(skip.getAttribute("data-tip")).toBe("跳过动画");
            expect(enter.tagName).toBe("A");
            expect(enter.getAttribute("href")).toBe("/agent");
            expect(enter.getAttribute("aria-label")).toBe("进入应用");
            expect(enter.getAttribute("title")).toBe("进入应用");
            for (const control of controls) {
                expect(control.querySelector("svg[aria-hidden='true']")).not.toBeNull();
                expect(control.getAttribute("data-umami-event")).toBeTruthy();
            }
            await act(async () => (skip as HTMLButtonElement).click());
            const back = container.querySelector<HTMLElement>(".lp-header button.lp-ic")!;
            expect(back.getAttribute("aria-label")).toBe("观看动画");
            expect(back.getAttribute("data-umami-event")).toBe("play-animation");
            expect(container.querySelectorAll(".lp-header .lp-ic")).toHaveLength(2); // static mode uses the same pair
        });

        it("leaves the stage text-only ('off') when the Canvas cannot be used, and shows no 画面 captions on the stage", async () => {
            await renderLanding();
            const stage = container.querySelector<HTMLElement>(".lp-stage")!;
            // The fake 2D context is not a real one, so the lazy renderer declines to mount.
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
            expect(stage.dataset.canvas).toBe("off");
            expect(stage.querySelector(".lp-caption")).toBeNull();
            expect(container.querySelector(".lp-sr-only")!.textContent).toContain("画面：");
        });

        it("keeps only the active stage layer interactive and follows the scroll position", async () => {
            await renderLanding();
            const inertness = () => layers().map(layer => layer.hasAttribute("inert"));
            expect(inertness()).toEqual([false, true, true, true, true, true]);
            await scrollTo((sceneProgressWindow(3).start + sceneProgressWindow(3).end) / 2);
            expect(inertness()).toEqual([true, true, true, false, true, true]);
            const rootStyle = container.querySelector<HTMLElement>(".lp-film")!.style;
            expect(rootStyle.getPropertyValue("--scene-index")).toBe("3");
            expect(Number(rootStyle.getPropertyValue("--film-progress"))).toBeCloseTo((sceneProgressWindow(3).start + sceneProgressWindow(3).end) / 2, 3);
            expect(Number(rootStyle.getPropertyValue("--scene-local"))).toBeCloseTo(0.5, 3);
        });

        it("writes the HUD timecode and scene label without React rendering", async () => {
            await renderLanding();
            const time = container.querySelector(".lp-hud-time")!;
            const label = container.querySelector(".lp-hud-scene")!;
            expect(time.textContent).toBe("00:00:00:00");
            const at = (progress: number) => frameToTimecode(progressToPlaybackTime(progress) / FILM_PLAY_SECONDS, FILM_PLAY_SECONDS);
            await scrollTo(0.5);
            expect(time.textContent).toBe(at(0.5));
            expect(label.textContent).toBe(SCENES[progressToFrame(0.5).sceneIndex].short);
            await scrollTo(1);
            expect(time.textContent).toBe("00:01:00:00");
        });

        it("registers passive scroll listeners and releases them, and its frames, on unmount", async () => {
            const add = vi.spyOn(window, "addEventListener");
            const remove = vi.spyOn(window, "removeEventListener");
            await renderLanding();
            const scrollCall = add.mock.calls.find(call => call[0] === "scroll");
            expect(scrollCall?.[2]).toEqual({passive: true});
            await scrollTo(0.2);
            window.dispatchEvent(new Event("scroll"));
            expect(rafQueue.size).toBeGreaterThan(0);
            await act(async () => root.render(createElement("div")));
            expect(remove.mock.calls.some(call => call[0] === "scroll")).toBe(true);
            expect(rafQueue.size).toBe(0);
        });

        it("runs no frames while the page is still", async () => {
            await renderLanding();
            await scrollTo(0.3);
            expect(rafQueue.size).toBe(0);
        });
    });

    describe("static mode", () => {
        it("stacks one section per scene with every link and no stage or HUD", async () => {
            await setReducedMotion(true);
            await renderLanding();
            const page = container.querySelector(".lp-page")!;
            expect(page.getAttribute("data-film-mode")).toBe("static");
            const sections = [...container.querySelectorAll("section[data-scene]")];
            expect(sections.map(section => section.getAttribute("data-scene"))).toEqual(SCENES.map(scene => scene.id));
            expect(container.querySelector(".lp-stage, .lp-hud, .lp-track, .lp-perf")).toBeNull();
            expect(container.querySelectorAll("h1")).toHaveLength(1);
            const hrefs = [...container.querySelectorAll("a")].map(a => a.getAttribute("href"));
            expect(hrefs).toEqual(expect.arrayContaining(["/agent", "#download", GITHUB_URL, `${GITHUB_URL}/releases`, `${GITHUB_URL}/blob/main/LICENSE`, "#main"]));
            for (const section of sections) {
                const copy = SCENE_COPY[section.getAttribute("data-scene") as keyof typeof SCENE_COPY];
                expect(section.querySelector(".lp-subtitle")?.textContent).toBe(copy.subtitle.text);
                expect(section.querySelector("h1, h2")?.nextElementSibling?.className).toBe("lp-subtitle"); // quoted under its title
            }
            for (const scene of STAGE_SCENES) {
                const copy = SCENE_COPY[scene.id];
                const section = container.querySelector(`section[data-scene="${scene.id}"]`)!;
                for (const point of copy.points) expect(section.textContent).toContain(point.text); // every point stays in the readable page
            }
            expect(container.querySelector("[data-film-look], .lp-marks")).toBeNull();
            expect(container.querySelectorAll(".lp-faq details")).toHaveLength(5);
            expect(rafQueue.size).toBe(0);
            expect(buttonByText("跳过动画")).toBeUndefined();
            expect(buttonByText("观看动画")).toBeUndefined(); // reduced motion: nothing to opt back into
        });

        it("is used when the browser has no 2D canvas", async () => {
            vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
            await renderLanding();
            expect(container.querySelector(".lp-page")?.getAttribute("data-film-mode")).toBe("static");
        });
    });

    describe("switching", () => {
        it("skips the animation, remembers it, and can bring it back", async () => {
            await renderLanding();
            await act(async () => buttonByText("跳过动画")!.click());
            expect(container.querySelector(".lp-page")?.getAttribute("data-film-mode")).toBe("static");
            expect(localStorage.getItem(SKIP_FILM_KEY)).toBe("1");
            expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
            await act(async () => buttonByText("观看动画")!.click());
            expect(container.querySelector(".lp-page")?.getAttribute("data-film-mode")).toBe("film");
            expect(localStorage.getItem(SKIP_FILM_KEY)).toBeNull();
        });

        it("starts static when the choice was stored earlier", async () => {
            localStorage.setItem(SKIP_FILM_KEY, "1");
            await renderLanding();
            expect(container.querySelector(".lp-page")?.getAttribute("data-film-mode")).toBe("static");
            expect(buttonByText("观看动画")).toBeTruthy();
        });

        it("still switches when localStorage throws", async () => {
            setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
            await renderLanding();
            await act(async () => buttonByText("跳过动画")!.click());
            expect(container.querySelector(".lp-page")?.getAttribute("data-film-mode")).toBe("static");
        });

        it("follows prefers-reduced-motion changes live", async () => {
            await renderLanding();
            expect(container.querySelector(".lp-page")?.getAttribute("data-film-mode")).toBe("film");
            await setReducedMotion(true);
            expect(container.querySelector(".lp-page")?.getAttribute("data-film-mode")).toBe("static");
            expect(container.querySelector(".lp-stage")).toBeNull();
            await setReducedMotion(false);
            expect(container.querySelector(".lp-page")?.getAttribute("data-film-mode")).toBe("film");
        });
    });

    it("drives the progress variables from a hook-owned element", async () => {
        function Probe() {
            const rootRef = useRef<HTMLDivElement>(null);
            const trackRef = useRef<HTMLDivElement>(null);
            useFilmProgress(rootRef, trackRef);
            return createElement("div", {ref: rootRef, id: "probe"}, createElement("div", {ref: trackRef, className: "lp-track"}));
        }
        await act(async () => root.render(createElement(Probe)));
        await scrollTo(0.25);
        const style = container.querySelector<HTMLElement>("#probe")!.style;
        expect(Number(style.getPropertyValue("--film-progress"))).toBeCloseTo(0.25, 3);
        expect(style.getPropertyValue("--scene-index")).not.toBe("");
        expect(style.getPropertyValue("--scene-local")).not.toBe("");
    });
});
