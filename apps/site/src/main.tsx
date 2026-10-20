import {type ReactNode, StrictMode, useEffect} from "react";
import {createRoot} from "react-dom/client";
import {initUmami} from "@momoki/distribution/analytics";
import {Landing} from "./Landing";
import "./styles/landing.css";

// Standalone entry: it must not import the application (storage, router,
// diagnostics, shell styles). Failures degrade to the static markup in landing.html.
const warn = (reason: unknown) => console.warn("[landing]", reason);
window.addEventListener("error", event => warn(event.message));
window.addEventListener("unhandledrejection", event => warn(event.reason));

function Reveal({onReady, children}: { onReady: () => void; children: ReactNode }) {
    useEffect(onReady, [onReady]);
    return children;
}

function start() {
    const root = document.getElementById("root");
    if (!root) return;
    try {
        initUmami();
        // Render beside the static markup and swap only after a successful commit,
        // so a render failure leaves the readable static page in place.
        const staticNodes = Array.from(root.childNodes);
        const host = document.createElement("div");
        host.hidden = true;
        root.append(host);
        const swap = () => {
            host.hidden = false;
            staticNodes.forEach(node => node.remove());
        };
        createRoot(host, {onUncaughtError: warn, onCaughtError: warn, onRecoverableError: warn}).render(
            <StrictMode><Reveal onReady={swap}><Landing/></Reveal></StrictMode>,
        );
    } catch (error) {
        warn(error);
    }
}

start();
