import {describe, expect, it} from "vitest";
import {classifyUpdate, parseVersion} from "@momoki/distribution/version";

describe("parseVersion", () => {
    it("accepts a strict X.Y.Z string", () => {
        expect(parseVersion("0.1.3")).toEqual([0, 1, 3]);
        expect(parseVersion("1.0.0")).toEqual([1, 0, 0]);
        expect(parseVersion("10.20.30")).toEqual([10, 20, 30]);
        expect(parseVersion("0.0.0")).toEqual([0, 0, 0]);
    });

    it.each([
        ["", "empty"],
        ["dev", "the development sentinel"],
        ["0.1", "two segments"],
        ["0.1.3.4", "four segments"],
        ["0.1.3-rc.1", "a prerelease suffix"],
        ["0.1.3+build", "build metadata"],
        ["v0.1.3", "a leading v"],
        [" 0.1.3", "padded whitespace"],
        ["0.01.3", "a leading zero"],
        ["0.1.03", "a leading zero in the patch"],
        ["00.1.3", "a leading zero in the major"],
        ["1.2.3 ", "trailing whitespace"],
        ["1.2.x", "a non-numeric segment"],
        [".1.2", "a missing segment"],
    ])("rejects %s (%s)", value => {
        expect(parseVersion(value)).toBeUndefined();
    });

    it.each([[undefined], [null], [3], [[]], [{}]])("rejects the non-string %s", value => {
        expect(parseVersion(value)).toBeUndefined();
    });

    it("rejects a segment beyond the safe integer range", () => {
        expect(parseVersion("9007199254740993.0.0")).toBeUndefined();
    });
});

describe("classifyUpdate", () => {
    it.each([
        ["0.1.2", "0.1.3", "update-available"],
        ["0.1.3", "0.1.3", "up-to-date"],
        ["0.1.4", "0.1.3", "ahead"],
        ["dev", "0.1.3", "unknown"],
        ["0.1.3", "dev", "unknown"],
        [undefined, "0.1.3", "unknown"],
        ["0.1.3", undefined, "unknown"],
    ] as const)("classifies %s against %s as %s", (current, latest, expected) => {
        expect(classifyUpdate(current, latest)).toBe(expected);
    });

    it("compares each segment numerically, not as text", () => {
        expect(classifyUpdate("0.1.9", "0.1.10")).toBe("update-available");
        expect(classifyUpdate("0.1.10", "0.1.9")).toBe("ahead");
        expect(classifyUpdate("0.2.0", "0.10.0")).toBe("update-available");
        expect(classifyUpdate("1.0.0", "0.99.99")).toBe("ahead");
    });

    it("treats a malformed version on either side as unknown", () => {
        expect(classifyUpdate("0.1.3", "0.1.3-rc.1")).toBe("unknown");
        expect(classifyUpdate("0.01.3", "0.1.3")).toBe("unknown");
        expect(classifyUpdate("", "")).toBe("unknown");
    });
});
