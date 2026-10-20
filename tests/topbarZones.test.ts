import {describe, expect, it} from "vitest";
import {topbarZones} from "@/app/layout/topbarZones";

describe("top bar zones", () => {
    it("sizes the left zone to the rail plus the open module navigation", () => {
        expect(topbarZones({narrow: false, navigationWidth: 260, panelWidth: 0, panelDocked: false}).navigation)
            .toBe("calc(var(--shell-rail-width) + 260px)");
        // A collapsed navigation leaves only the rail.
        expect(topbarZones({narrow: false, navigationWidth: 0, panelWidth: 0, panelDocked: false}).navigation)
            .toBe("calc(var(--shell-rail-width) + 0px)");
    });

    it("gives the panel zone the panel's width plus the frame inset and surface border it reaches into", () => {
        const zones = topbarZones({narrow: false, navigationWidth: 260, panelWidth: 400, panelDocked: true});
        expect(zones).toMatchObject({panelShown: true, panel: "calc(400px + var(--shell-inset) + 1px)"});
    });

    it("has no panel zone when the panel is not docked or its width is zero", () => {
        expect(topbarZones({narrow: false, navigationWidth: 260, panelWidth: 400, panelDocked: false})).toMatchObject({panelShown: false, panel: "0px"});
        expect(topbarZones({narrow: false, navigationWidth: 260, panelWidth: 0, panelDocked: true})).toMatchObject({panelShown: false, panel: "0px"});
    });

    it("collapses to a single bar on a narrow window", () => {
        expect(topbarZones({narrow: true, navigationWidth: 260, panelWidth: 400, panelDocked: true}))
            .toEqual({navigation: "0px", panel: "0px", panelShown: false});
    });
});
