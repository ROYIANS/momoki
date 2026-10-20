import {beforeEach,describe,expect,it,vi} from "vitest";
import type {ReactElement} from "react";
const hooks = vi.hoisted(() => ({cells: [] as unknown[],cursor:0}));
vi.mock("react",async original => {
    const react = await original<typeof import("react")>();
    return {...react,
        useState(initial: unknown) {const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = typeof initial === "function" ? initial() : initial; return [hooks.cells[i],(next: unknown) => {hooks.cells[i] = typeof next === "function" ? next(hooks.cells[i]) : next;}];},
        useRef(initial: unknown) {const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = {current:initial}; return hooks.cells[i];},
        useCallback: (callback: unknown) => callback,useMemo: (compute: () => unknown) => compute(),
    };
});
import {ContextPanelHostProvider} from "@/app/layout/ContextPanelHost";
type Host = {active: string | null;docked: boolean;fullWidth: boolean;width: number;
    activeTitle: string | null;canToggle: boolean;closeActive: () => void;toggle: () => void;
    wouldDock: (width: number) => boolean;markOffered: (key: string) => void;isOffered: (key: string) => boolean;setPanelWidth: (width: number) => void;
    register: (entry:{id:string;width:number;title?:string;kind?:string;reopen?:()=>void;close:(reason?:string)=>void;depart:(proceed:()=>void,cancel:()=>void)=>void})=>()=>void;
    request:(id:string)=>void;release:(id:string)=>void};
function draw(surfaceWidth = 1440,navigationWidth = 260): Host {
    hooks.cursor = 0;
    const tree = ContextPanelHostProvider({target:null,surfaceWidth,navigationWidth,children:null}) as ReactElement<{value:Host}>;
    return tree.props.value;
}
beforeEach(() => {hooks.cells = []; hooks.cursor = 0;});
describe("controlled context-panel coordination", () => {
    it("keeps the outgoing owner until explicit acceptance and rejects a competing opener", () => {
        let accept = () => {},cancel = () => {};
        const outgoingClose = vi.fn(),incomingClose = vi.fn(),competitorClose = vi.fn();
        let host = draw();
        host.register({id:"material",width:400,close:outgoingClose,depart:(yes,no)=>{accept=yes;cancel=no;}});
        host.register({id:"task",width:400,close:incomingClose,depart:yes=>yes()});
        host.register({id:"memory",width:400,close:competitorClose,depart:yes=>yes()});
        host.request("material"); host = draw(); expect(host.active).toBe("material");
        host.request("task"); expect(draw().active).toBe("material");
        host.request("memory"); expect(competitorClose).toHaveBeenCalledExactlyOnceWith("busy");
        const staleAcceptance = accept;
        cancel(); staleAcceptance(); expect(incomingClose).toHaveBeenCalledExactlyOnceWith("guard-refused"); expect(draw().active).toBe("material");
        host.request("task"); accept(); expect(outgoingClose).toHaveBeenCalledExactlyOnceWith("replaced"); expect(draw().active).toBe("task");
    });
    it("cannot activate a removed candidate from an old discard completion", () => {
        let accept = () => {};
        const host = draw();
        host.register({id:"a",width:320,close:vi.fn(),depart:yes=>{accept=yes;}});
        const remove = host.register({id:"b",width:400,close:vi.fn(),depart:yes=>yes()});
        host.request("a"); host.request("b"); remove(); accept();
        expect(draw().active).toBe("a");
    });
    it("bases docking on actual surface allocation and keeps the same active identity", () => {
        const host = draw(); host.register({id:"music",width:300,close:vi.fn(),depart:yes=>yes()}); host.request("music");
        expect(draw(1120,340)).toMatchObject({active:"music",docked:true,fullWidth:false,width:300});
        expect(draw(1119,340)).toMatchObject({active:"music",docked:false,fullWidth:true,width:300});
        expect(draw(1119,0)).toMatchObject({active:"music",docked:true,fullWidth:false,width:300});
        host.release("music"); expect(draw(760)).toMatchObject({active:null,fullWidth:false});
    });
    it.each([300,320,400])("uses full-width mode below the measured allocation for a %ipx panel", width => {
        const host = draw();
        host.register({id:"detail",width,close:vi.fn(),depart:yes=>yes()}); host.request("detail");
        const threshold = 260 + width + 480;
        expect(draw(threshold)).toMatchObject({active:"detail",docked:true,fullWidth:false});
        expect(draw(threshold - 1)).toMatchObject({active:"detail",docked:false,fullWidth:true});
        expect(draw(390)).toMatchObject({active:"detail",docked:false,fullWidth:true});
    });

    it("carries the active panel's title for the top bar and clears it on release", () => {
        const host = draw(); host.register({id:"task",width:400,title:"任务工作台",close:vi.fn(),depart:yes=>yes()});
        expect(draw().activeTitle).toBeNull();
        host.request("task"); expect(draw().activeTitle).toBe("任务工作台");
        host.release("task"); expect(draw().activeTitle).toBeNull();
    });
    it("closes the active panel through its own departure guard, as a user close", () => {
        let accept = () => {},cancel = () => {};
        const close = vi.fn(),host = draw();
        host.register({id:"edit",width:400,close,depart:(yes,no)=>{accept=yes;cancel=no;}});
        host.request("edit"); draw().closeActive();
        // A guard that has not decided yet must not close the panel.
        expect(close).not.toHaveBeenCalled();
        cancel(); expect(close).not.toHaveBeenCalled(); expect(draw().active).toBe("edit");
        draw().closeActive(); accept(); expect(close).toHaveBeenCalledExactlyOnceWith("user");
    });
    it("toggles: closes the open panel, and reopens the last one when none is open", () => {
        const close = vi.fn(),reopen = vi.fn(),host = draw();
        host.register({id:"skills",width:400,close,reopen,depart:yes=>yes()});
        expect(draw().canToggle).toBe(false);
        host.request("skills"); expect(draw().canToggle).toBe(true);
        draw().toggle(); expect(close).toHaveBeenCalledExactlyOnceWith("user");
        host.release("skills"); expect(draw().active).toBeNull(); expect(draw().canToggle).toBe(true);
        draw().toggle(); expect(reopen).toHaveBeenCalledOnce();
    });
    it("does nothing on toggle when the last panel is no longer registered", () => {
        const reopen = vi.fn(),host = draw();
        const remove = host.register({id:"gone",width:400,close:vi.fn(),reopen,depart:yes=>yes()});
        host.request("gone"); host.release("gone"); remove();
        expect(() => draw().toggle()).not.toThrow(); expect(reopen).not.toHaveBeenCalled();
    });

    it("remembers what was offered so the same thing is never opened automatically twice", () => {
        const host = draw();
        expect(host.isOffered("batch:1")).toBe(false);
        host.markOffered("batch:1");
        expect(draw().isOffered("batch:1")).toBe(true);
        expect(draw().isOffered("batch:2")).toBe(false);
    });
    it("says whether a panel would dock beside the content at the current allocation", () => {
        expect(draw(1140,260).wouldDock(400)).toBe(true);
        expect(draw(1139,260).wouldDock(400)).toBe(false);
    });
    it("applies a dragged width within limits, only to the active panel", () => {
        const host = draw(); host.register({id:"task",width:400,kind:"task",close:vi.fn(),depart:yes=>yes()});
        host.setPanelWidth(900); expect(draw().width).toBe(400);
        host.request("task"); draw().setPanelWidth(600); expect(draw()).toMatchObject({width:600,docked:true});
        draw().setPanelWidth(10); expect(draw().width).toBe(320);
        draw(1000,260).setPanelWidth(700); expect(draw(1000,260).width).toBe(320);
    });
});
