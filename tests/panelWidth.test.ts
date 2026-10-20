import {afterEach, describe, expect, it, vi} from "vitest";
import {canDockPanel, clampPanelWidth, readPanelWidth, shouldAutoOpenPanel, writePanelWidth} from "@/app/layout/panelWidth";

const space = (surfaceWidth: number, navigationWidth = 260) => ({surfaceWidth, navigationWidth});
afterEach(() => vi.unstubAllGlobals());

describe("panel width limits", () => {
    it("keeps a panel between its own minimum and maximum", () => {
        expect(clampPanelWidth(100, space(1800))).toBe(320);
        expect(clampPanelWidth(500, space(1800))).toBe(500);
        expect(clampPanelWidth(5000, space(1800))).toBe(720);
    });

    it("never lets the panel squeeze the content below 480", () => {
        // 1100 - 260 - 480 = 360 of room.
        expect(clampPanelWidth(700, space(1100))).toBe(360);
        // No room at all still honours the panel minimum; docking is a separate question.
        expect(clampPanelWidth(700, space(700))).toBe(320);
    });

    it("rounds a dragged width to a whole pixel", () => {
        expect(clampPanelWidth(450.6, space(1800))).toBe(451);
    });

    it("docks exactly when the content keeps its minimum", () => {
        expect(canDockPanel(400, space(1140))).toBe(true);
        expect(canDockPanel(400, space(1139))).toBe(false);
        expect(canDockPanel(400, space(1139, 0))).toBe(true);
    });
});

describe("remembered width", () => {
    const store = () => {
        const data = new Map<string, string>();
        return {getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v)};
    };

    it("round-trips per panel kind", () => {
        vi.stubGlobal("localStorage", store());
        writePanelWidth("task", 480);
        expect(readPanelWidth("task")).toBe(480);
        expect(readPanelWidth("skills")).toBeUndefined();
        expect(readPanelWidth(undefined)).toBeUndefined();
    });

    it("ignores unusable stored values and unavailable storage", () => {
        vi.stubGlobal("localStorage", {...store(), getItem: () => "not a number"});
        expect(readPanelWidth("task")).toBeUndefined();
        vi.stubGlobal("localStorage", {getItem: () => {throw new Error("blocked");}, setItem: () => {throw new Error("blocked");}});
        expect(readPanelWidth("task")).toBeUndefined();
        expect(() => writePanelWidth("task", 400)).not.toThrow();
    });
});

describe("automatic opening", () => {
    const base = {ready: true, open: false, hasActivePanel: false, offeredBefore: false, fitsBesideContent: true};

    it("opens once when something is ready, free to dock and not offered before", () => {
        expect(shouldAutoOpenPanel(base)).toBe(true);
    });

    it.each([
        ["nothing needs the user yet", {ready: false}],
        ["it is already open", {open: true}],
        ["another panel is open (it is not replaced)", {hasActivePanel: true}],
        ["it was offered or closed before", {offeredBefore: true}],
        ["it would cover the content", {fitsBesideContent: false}],
    ])("does not open when %s", (_label, patch) => {
        expect(shouldAutoOpenPanel({...base, ...patch})).toBe(false);
    });
});
