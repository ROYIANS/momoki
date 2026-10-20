import {useRef, useState} from "react";
import {LOGO_LOOP_SRC, LOGO_SRC} from "@momoki/distribution/brand";

function hoverPlaybackAllowed() {
    return typeof window !== "undefined"
        && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

/**
 * Home hero mark: static logo at rest, brand animation on hover.
 * The video opens on the same composition as the logo, so the fade-in has no
 * jump; it holds its last frame until the pointer leaves, then fades back.
 */
export function HeroLogo() {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [active, setActive] = useState(false);
    const [failed, setFailed] = useState(false);
    const [canAnimate] = useState(hoverPlaybackAllowed);

    const enter = () => {
        const video = videoRef.current;
        if (!canAnimate || failed || !video) return;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        if (video.ended) video.currentTime = 0;
        setActive(true);
        void video.play().catch(() => setFailed(true));
    };

    const leave = () => {
        setActive(false);
        videoRef.current?.pause();
    };

    return (
        <div className={active ? "agent-home-logo-wrap is-active" : "agent-home-logo-wrap"} onMouseEnter={enter}
             onMouseLeave={leave}>
            <img className="agent-home-logo-image" src={LOGO_SRC} alt="" width={120} height={120}/>
            {canAnimate && !failed && (
                <video
                    ref={videoRef}
                    className={active ? "agent-home-logo-video is-active" : "agent-home-logo-video"}
                    src={LOGO_LOOP_SRC}
                    muted
                    playsInline
                    preload="none"
                    aria-hidden
                    onError={() => setFailed(true)}
                />
            )}
        </div>
    );
}
