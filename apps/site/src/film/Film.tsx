import {type CSSProperties, type ReactNode, useEffect, useRef, useState} from "react";
import {GITHUB_URL, LOGO_SRC, PRODUCT_NAME_ZH, STUDIO_NAME_ZH, STUDIO_URL} from "@momoki/distribution/brand";
import {PRIVACY} from "../content/copy";
import {Credits} from "../credits/Credits";
import type {DownloadData} from "../download/useReleases";
import {Hud, Perforations} from "./Hud";
import {useFilmMode} from "./mode";
import {SceneBody} from "./SceneBody";
import {STAGE_SCENES, TOTAL_WEIGHT} from "./scenes";
import {SkipButton} from "./SkipButton";
import {IconControl} from "../ui/IconControl";
import {sceneLabel} from "./playback";
import {SCENE_FADE, sceneProgressWindow} from "./timeline";
import {useFilmProgress} from "./useFilmProgress";
import {usePlayback, usePlaybackState} from "./usePlayback";

const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;
const LAST_STAGE = STAGE_SCENES.length - 1;

// The toggle comes first in the DOM (first Tab stop) and is moved visually by CSS;
// both header actions are the same round icon control.
function Header({toggle}: { toggle: ReactNode }) {
    return (
        <header className="lp-header">
            <div className="lp-header-inner">
                {toggle}
                <a className="lp-brand" href="/"><img src={LOGO_SRC} alt="" width={28} height={28}/><span>默默</span></a>
                <nav aria-label="主要"><IconControl icon="enter" label="进入应用" reveal="hover" umami="enter-app"
                                                    href="/agent"/></nav>
            </div>
        </header>
    );
}

function Footer() {
    return (
        <footer className="lp-footer">
            <div className="lp-wrap">
                <p>{PRIVACY.text}</p>
                <p>{PRODUCT_NAME_ZH} · <a href={STUDIO_URL} rel="noopener noreferrer">{STUDIO_NAME_ZH}</a>出品</p>
                <p className="lp-links">
                    <a href={GITHUB_URL} rel="noopener noreferrer">GitHub</a>
                    <a href={LICENSE_URL} rel="noopener noreferrer">MIT 协议</a>
                    <a href="/agent">进入应用</a>
                </p>
            </div>
        </footer>
    );
}

// Readable page: one <section> per scene, plain document flow, no pinned stage.
// Keep its text and links equivalent to the static markup in landing.html
// (tests/landingEntry.test.ts compares them).
function StaticPage({download, skipped, onToggle}: { download: DownloadData; skipped: boolean; onToggle: () => void }) {
    return (
        <div className="lp-page" data-film-mode="static">
            <a className="lp-skip" href="#main">跳到正文</a>
            <Header toggle={skipped ? <SkipButton skipped onToggle={onToggle}/> : null}/>
            <main id="main">
                <div className="lp-wrap">
                    {STAGE_SCENES.map(scene => {
                        const hero = scene.id === "leader";
                        return (
                            <section key={scene.id} className={hero ? "lp-scene lp-hero" : "lp-scene"}
                                     data-scene={scene.id} aria-labelledby={hero ? "lp-title" : `lp-scene-${scene.id}`}>
                                <SceneBody id={scene.id} heading={hero ? "h1" : "h2"}
                                           headingId={hero ? "lp-title" : `lp-scene-${scene.id}`}/>
                                {hero ? (
                                    <div className="lp-actions">
                                        <a className="lp-btn lp-btn-primary" href="/agent"
                                           data-umami-event="try-online-hero">在浏览器中体验</a>
                                        <a className="lp-btn" href="#download"
                                           data-umami-event="download-hero">下载桌面版</a>
                                        <a className="lp-btn" href={GITHUB_URL} rel="noopener noreferrer"
                                           data-umami-event="github-hero">GitHub</a>
                                    </div>
                                ) : null}
                            </section>
                        );
                    })}
                    <Credits download={download}/>
                </div>
            </main>
            <Footer/>
        </div>
    );
}

// Scroll-driven film. Layout: a track `TOTAL_WEIGHT` viewports tall holds a
// sticky 100svh stage; the closing credits follow as normal flow once the stage
// is released. The stage art is decorative (aria-hidden; the player controls beside it are not); a visually hidden copy of
// the six stage scenes' text provides the reading order for assistive tech, and
// the credits are the one real interactive region. Stage layers other than the
// active scene are `inert`, so nothing hidden can take focus.
function FilmPage({download, onToggle}: { download: DownloadData; onToggle: () => void }) {
    const rootRef = useRef<HTMLDivElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const lookRef = useRef<HTMLCanvasElement>(null);
    const stageHandle = useRef<{ wake: () => void } | undefined>(undefined);
    const driver = useFilmProgress(rootRef, trackRef);
    const playback = usePlayback(trackRef);
    const playbackState = usePlaybackState(playback);
    const [active, setActive] = useState(0);
    const [atStart, setAtStart] = useState(true);
    const [announcement, setAnnouncement] = useState("");
    // The Canvas 2D picture is a separate lazy chunk. Until it reports in, the stage is
    // "pending" (CSS holds the leader's text back); if it cannot run, "off" restores the text.
    useEffect(() => {
        const stage = stageRef.current;
        const canvas = canvasRef.current;
        if (!stage || !canvas) return undefined;
        let cancelled = false;
        let handle: { destroy: () => void; wake: () => void } | undefined;
        import("./renderers/stage").then(module => {
            if (cancelled) return;
            handle = module.mountStage({
                stage,
                canvas,
                driver,
                lookCanvas: lookRef.current,
                isFrozen: () => playback.state() === "paused"
            });
            stageHandle.current = handle;
            if (!handle) stage.dataset.canvas = "off";
        }).catch(() => {
            if (!cancelled) stage.dataset.canvas = "off";
        });
        return () => {
            cancelled = true;
            stageHandle.current = undefined;
            handle?.destroy();
        };
    }, [driver, playback]);
    // Scene changes are announced only while the film plays itself; scrolling by hand stays quiet.
    useEffect(() => driver.subscribe(({sceneIndex, progress}) => {
        setActive(sceneIndex);
        setAtStart(progress < 0.01);
        if (playback.state() === "playing") setAnnouncement(sceneLabel(sceneIndex));
    }), [driver, playback]);
    // The film look freezes while paused; resuming (or finishing) wakes the stage's loop again.
    useEffect(() => stageHandle.current?.wake(), [playbackState]);
    const showStart = atStart && playbackState !== "playing";
    const track = {"--film-length": TOTAL_WEIGHT, "--fade": SCENE_FADE} as CSSProperties;
    return (
        <div className="lp-page lp-film" data-film-mode="film" ref={rootRef}>
            <Header toggle={<SkipButton skipped={false} onToggle={onToggle}/>}/>
            <main id="main">
                <div className="lp-sr-only">
                    {STAGE_SCENES.map(scene => (
                        <section key={scene.id} data-sr-scene={scene.id} aria-labelledby={`lp-sr-${scene.id}`}>
                            <SceneBody id={scene.id} heading={scene.id === "leader" ? "h1" : "h2"}
                                       headingId={`lp-sr-${scene.id}`}/>
                        </section>
                    ))}
                </div>
                <div className="lp-sr-only" role="status" aria-live="polite" data-playback-live>{announcement}</div>
                <div className="lp-track" ref={trackRef} style={track}>
                    <div className="lp-stage" data-canvas="pending" ref={stageRef}>
                        <div className="lp-stage-art" aria-hidden="true">
                            <div className="lp-stage-bg"/>
                            <div className="lp-picture" data-film-weave>
                                <canvas className="lp-canvas" data-film-canvas aria-hidden="true" ref={canvasRef}/>
                                <canvas className="lp-look" data-film-look aria-hidden="true" ref={lookRef}/>
                            </div>
                            <div className="lp-vignette"/>
                            <Perforations/>
                            <div className="lp-marks"><span data-mark="reel"/><span data-mark="scene"/></div>
                            {STAGE_SCENES.map((scene, index) => {
                                const {start, end} = sceneProgressWindow(index);
                                // The first scene is fully visible at progress 0 and the last at 1.
                                const layerWindow = {
                                    "--s": index === 0 ? -SCENE_FADE : start,
                                    "--e": index === LAST_STAGE ? 1 + SCENE_FADE : end
                                } as CSSProperties;
                                return (
                                    <div key={scene.id} className="lp-layer" data-scene-layer={scene.id}
                                         inert={index !== active} style={layerWindow}>
                                        <SceneBody id={scene.id} stage/>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="lp-start" data-on={showStart} inert={!showStart}>
                            <IconControl className="lp-ic-xl" icon="play" label="播放" reveal="none" umami="play-film"
                                         onClick={() => playback.play()}/>
                            <span className="lp-start-text" aria-hidden="true">点击播放</span>
                        </div>
                        <Hud driver={driver} playback={playback}/>
                    </div>
                </div>
                <div className="lp-wrap"><Credits download={download}/></div>
            </main>
            <Footer/>
        </div>
    );
}

export function Film({download}: { download: DownloadData }) {
    const {mode, skipped, setSkipped} = useFilmMode();
    const toggle = () => {
        setSkipped(!skipped);
        try {
            window.scrollTo(0, 0);
        } catch {
            // scrolling is a nicety only
        }
    };
    return mode === "film" ? <FilmPage download={download} onToggle={toggle}/> :
        <StaticPage download={download} skipped={skipped} onToggle={toggle}/>;
}
