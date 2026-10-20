import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initUmami } from "@momoki/distribution/analytics";

function mockDocument() {
  const scripts: Array<{
    id: string;
    src: string;
    async: boolean;
    setAttribute: ReturnType<typeof vi.fn>;
  }> = [];
  const document = {
    getElementById: vi.fn((id: string) => scripts.find((script) => script.id === id) ?? null),
    createElement: vi.fn(() => ({ id: "", src: "", async: false, setAttribute: vi.fn() })),
    head: {
      appendChild: vi.fn((script: (typeof scripts)[number]) => scripts.push(script)),
    },
  };
  vi.stubGlobal("document", document);
  return { document, scripts };
}

describe("Umami initialization", () => {
  beforeEach(() => {
    vi.stubEnv("PROD", true);
    vi.stubEnv("VITE_UMAMI_SCRIPT_URL", "https://analytics.example.com/script.js");
    vi.stubEnv("VITE_UMAMI_WEBSITE_ID", "website-id");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(["https://analytics.example.com/script.js", "http://localhost:3000/script.js"])(
    "loads %s asynchronously with the configured website ID",
    (url) => {
      const { document, scripts } = mockDocument();
      vi.stubEnv("VITE_UMAMI_SCRIPT_URL", `  ${url}  `);
      vi.stubEnv("VITE_UMAMI_WEBSITE_ID", "  website-id  ");

      initUmami();

      expect(document.createElement).toHaveBeenCalledWith("script");
      expect(scripts).toHaveLength(1);
      expect(scripts[0].src).toBe(url);
      expect(scripts[0].async).toBe(true);
      expect(scripts[0].setAttribute).toHaveBeenCalledExactlyOnceWith("data-website-id", "website-id");
    },
  );

  it("does not load analytics during development", () => {
    const { document } = mockDocument();
    vi.stubEnv("PROD", false);

    initUmami();

    expect(document.createElement).not.toHaveBeenCalled();
    expect(document.head.appendChild).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, undefined],
    [undefined, "website-id"],
    ["https://analytics.example.com/script.js", undefined],
    ["", "website-id"],
    ["https://analytics.example.com/script.js", ""],
    ["  ", "website-id"],
    ["https://analytics.example.com/script.js", "  "],
  ])("skips incomplete configuration (%s, %s)", (url, websiteId) => {
    const { document } = mockDocument();
    vi.stubEnv("VITE_UMAMI_SCRIPT_URL", url);
    vi.stubEnv("VITE_UMAMI_WEBSITE_ID", websiteId);

    initUmami();

    expect(document.createElement).not.toHaveBeenCalled();
    expect(document.head.appendChild).not.toHaveBeenCalled();
  });

  it.each([
    "/script.js",
    "//analytics.example.com/script.js",
    "javascript:alert(1)",
    "data:text/javascript,alert(1)",
    "ftp://analytics.example.com/script.js",
    "https:script.js",
    "https://",
    "https://invalid host/script.js",
  ])("ignores invalid script URL %s without throwing", (url) => {
    const { document } = mockDocument();
    vi.stubEnv("VITE_UMAMI_SCRIPT_URL", url);

    expect(() => initUmami()).not.toThrow();

    expect(document.createElement).not.toHaveBeenCalled();
    expect(document.head.appendChild).not.toHaveBeenCalled();
  });

  it("loads only one tracker when initialized repeatedly", () => {
    const { document, scripts } = mockDocument();

    initUmami();
    initUmami();

    expect(scripts).toHaveLength(1);
    expect(document.createElement).toHaveBeenCalledTimes(1);
    expect(document.head.appendChild).toHaveBeenCalledTimes(1);
  });
});
