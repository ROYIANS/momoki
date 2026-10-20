import {GITHUB_URL} from "@momoki/distribution/brand";
import {HERO_NOTE, ONLINE_NOTES, OPEN_SOURCE, SCENE_COPY} from "../content/copy";
import {FAQ} from "../content/faq";
import {DownloadCard} from "../download/DownloadCard";
import {StarPrompt} from "../download/StarPrompt";
import type {DownloadData} from "../download/useReleases";

const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;

// The closing credits: online experience, download, star, open source, FAQ.
// Real, focusable document flow in both modes (never inside the pinned stage).
export function Credits({download}: { download: DownloadData }) {
    const copy = SCENE_COPY.credits;
    return (
        <section className="lp-credits" data-scene="credits" aria-labelledby="lp-credits-title">
            <p className="lp-kicker">{copy.kicker}</p>
            <h2 id="lp-credits-title" className="lp-scene-title">{copy.title}</h2>
            <p className="lp-subtitle">{copy.subtitle.text}</p>
            <p className="lp-narration">{copy.narration.text}</p>
            <div className="lp-actions">
                <a className="lp-btn lp-btn-primary" href="/agent" data-umami-event="try-online">在浏览器中体验</a>
                <a className="lp-btn" href="#download" data-umami-event="download">下载桌面版</a>
                <a className="lp-btn" href={GITHUB_URL} rel="noopener noreferrer" data-umami-event="github">GitHub</a>
            </div>
            <p className="lp-note">{HERO_NOTE.text}</p>
            <DownloadCard release={download.release} platform={download.platform}/>
            <section className="lp-section" aria-labelledby="lp-online">
                <h2 id="lp-online">在线体验</h2>
                <ul className="lp-notes">
                    {ONLINE_NOTES.map(note => <li key={note.text}>{note.text}</li>)}
                </ul>
            </section>
            <section className="lp-section" aria-labelledby="lp-open">
                <h2 id="lp-open">开源与 Star</h2>
                <div className="lp-open">
                    <div className="lp-open-info">
                        <p className="lp-narration">{OPEN_SOURCE.text}</p>
                        <p className="lp-links lp-links-quiet"><a href={LICENSE_URL} rel="noopener noreferrer">MIT
                            协议</a><a href={GITHUB_URL} rel="noopener noreferrer">GitHub 仓库</a></p>
                    </div>
                    <StarPrompt stars={download.stars}/>
                </div>
            </section>
            <section className="lp-section" aria-labelledby="lp-faq">
                <h2 id="lp-faq">常见问题</h2>
                <div className="lp-faq">
                    {FAQ.map(item => (
                        <details key={item.question}>
                            <summary>{item.question}</summary>
                            <p>{item.answer.text}</p>
                        </details>
                    ))}
                </div>
            </section>
        </section>
    );
}
