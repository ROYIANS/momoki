import {readdirSync, readFileSync, statSync} from "node:fs";
import {join, relative} from "node:path";
import {expect, it} from "vitest";

/**
 * A dialog is for an alert or confirmation, or a single field (a rename). Anything with more to it — forms,
 * pickers, editors, review — belongs in the right side panel (`SidePanel`). New dialogs must be added here on
 * purpose, with the reason they are not a panel.
 */
const ALLOWED = new Map<string, string>([
    ["features/agent/ui/AgentChatPage.tsx", "rename a thread: one field"],
    ["features/projects/ui/ProjectGalleryPage.tsx", "rename a project: one field"],
    ["features/audio/ui/ScriptDocument.tsx", "paste a script: one text field"],
    ["features/audio/ui/AudioSources.tsx", "recording: the microphone session needs the user's whole attention"],
    ["features/settings/ui/AboutPage.tsx", "enlarged appreciation code image: a lightbox"],
    ["features/agent/ui/ReferenceAttachments.tsx", "enlarged previews of an attached source or image: a lightbox"],
    ["app/errors/ErrorDetailsDialog.tsx", "details of an error alert"],
]);

const root = join(__dirname, "../packages/studio/src");
function sources(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sources(path);
        return /\.tsx?$/.test(name) ? [path] : [];
    });
}

it("keeps dialogs to alerts, confirmations and single fields; everything else is a side panel", () => {
    const users = sources(root)
        .filter(path => /from ["'][./]+\/ui\/dialog["']/.test(readFileSync(path, "utf8")))
        .map(path => relative(root, path)).sort();
    expect(users.filter(path => !ALLOWED.has(path))).toEqual([]);
    // An entry that no longer uses a dialog should leave the list.
    expect([...ALLOWED.keys()].filter(path => !users.includes(path))).toEqual([]);
});
