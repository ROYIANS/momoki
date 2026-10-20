import {useEffect, useState} from "react";
import {type DetectedPlatform, detectPlatform, type NavigatorInfo} from "@momoki/distribution/platform";
import {fetchLatestDesktopRelease, fetchStars, type ReleaseResult} from "@momoki/distribution/releases";

export type DownloadData = { release?: ReleaseResult; platform?: DetectedPlatform; stars?: number };

// Requests start after mount, so they never block the first render. The three
// lookups are independent: a slow or failed one does not delay the others.
export function useDownloadData(): DownloadData {
    const [data, setData] = useState<DownloadData>({});
    useEffect(() => {
        const controller = new AbortController();
        const {signal} = controller;
        const update = (patch: DownloadData) => {
            if (!signal.aborted) setData(current => ({...current, ...patch}));
        };
        void detectPlatform(navigator as unknown as NavigatorInfo).then(platform => update({platform}));
        void fetchLatestDesktopRelease({signal}).then(release => update({release}));
        void fetchStars({signal}).then(stars => {
            if (stars !== undefined) update({stars});
        });
        return () => controller.abort();
    }, []);
    return data;
}
