const UMAMI_SCRIPT_ID = "momoki-umami";

export function initUmami(): void {
    if (!import.meta.env.PROD) return;

    const scriptUrl = import.meta.env.VITE_UMAMI_SCRIPT_URL?.trim();
    const websiteId = import.meta.env.VITE_UMAMI_WEBSITE_ID?.trim();
    if (!scriptUrl || !websiteId || !/^https?:\/\//i.test(scriptUrl)) return;

    try {
        const url = new URL(scriptUrl);
        if (url.protocol !== "https:" && url.protocol !== "http:") return;
    } catch {
        return;
    }

    if (document.getElementById(UMAMI_SCRIPT_ID)) return;

    const script = document.createElement("script");
    script.id = UMAMI_SCRIPT_ID;
    script.src = scriptUrl;
    script.async = true;
    script.setAttribute("data-website-id", websiteId);
    document.head.appendChild(script);
}
