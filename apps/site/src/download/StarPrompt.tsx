import {GITHUB_URL} from "@momoki/distribution/brand";
import {IconControl} from "../ui/IconControl";
import {formatStars} from "./format";

/** A handful of stars reads as a weakness, so the number appears only from this count on. */
export const STAR_DISPLAY_THRESHOLD = 50;

// A quiet closing-credits prompt: one line of text and one icon-button link. No
// third-party badge or image: the count comes from the GitHub API and is omitted
// when unavailable or small.
export function StarPrompt({stars}: { stars?: number }) {
    const showCount = stars !== undefined && stars >= STAR_DISPLAY_THRESHOLD;
    return (
        <div className="lp-star">
            <p>如果它对你有用，欢迎在 GitHub 点一颗 star。</p>
            <IconControl icon="star" label="前往 GitHub 点 star" reveal="always" umami="star" href={GITHUB_URL}
                         rel="noopener noreferrer"/>
            {showCount ? <span className="lp-star-count">（{formatStars(stars)}）</span> : null}
        </div>
    );
}
