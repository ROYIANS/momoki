import {useCallback, useEffect, useState} from "react";

export type FilmMode = "film" | "static";

export const SKIP_FILM_KEY = "momoki.landing.skipFilm";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function resolveFilmMode({reducedMotion, skipped, canvas2d}: {
    reducedMotion: boolean;
    skipped: boolean;
    canvas2d: boolean
}): FilmMode {
    return reducedMotion || skipped || !canvas2d ? "static" : "film";
}

function defaultStorage(): StorageLike | undefined {
    try {
        return window.localStorage;
    } catch {
        return undefined;
    }
}

export function readSkipPreference(storage: StorageLike | undefined = defaultStorage()): boolean {
    try {
        return storage?.getItem(SKIP_FILM_KEY) === "1";
    } catch {
        return false;
    }
}

/** Storage failures are ignored: the choice still applies for this visit. */
export function writeSkipPreference(skipped: boolean, storage: StorageLike | undefined = defaultStorage()): void {
    try {
        if (skipped) storage?.setItem(SKIP_FILM_KEY, "1");
        else storage?.removeItem(SKIP_FILM_KEY);
    } catch {
        // ignored on purpose
    }
}

function detectCanvas2d(): boolean {
    try {
        return Boolean(document.createElement("canvas").getContext("2d"));
    } catch {
        return false;
    }
}

function prefersReducedMotion(): boolean {
    return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export function useFilmMode(): { mode: FilmMode; skipped: boolean; setSkipped: (value: boolean) => void } {
    const [skipped, setSkippedState] = useState(() => readSkipPreference());
    const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
    const [canvas2d] = useState(detectCanvas2d);

    useEffect(() => {
        if (typeof window.matchMedia !== "function") return undefined;
        const query = window.matchMedia(REDUCED_MOTION_QUERY);
        const update = () => setReducedMotion(query.matches);
        update();
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
    }, []);

    const setSkipped = useCallback((value: boolean) => {
        setSkippedState(value);
        writeSkipPreference(value);
    }, []);

    return {mode: resolveFilmMode({reducedMotion, skipped, canvas2d}), skipped, setSkipped};
}
