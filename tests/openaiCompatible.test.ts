import {authHeaders, chatCompletionsUrl} from "@momoki/agent-providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  maskApiKey,
  listModels,
  modelsUrl,
  normalizeBaseUrl,
  testConnection,
} from "@/features/agent/providers/openaiCompatible";

describe("openaiCompatible helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes base URLs by trimming and stripping trailing slashes", () => {
    expect(normalizeBaseUrl(" https://api.openai.com/v1/ ")).toBe("https://api.openai.com/v1");
    expect(normalizeBaseUrl("https://api.deepseek.com/v1///")).toBe("https://api.deepseek.com/v1");
    expect(modelsUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1/models");
    expect(chatCompletionsUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("builds a Bearer Authorization header", () => {
    expect(authHeaders(" sk-test ")).toEqual({
      Authorization: "Bearer sk-test",
      "Content-Type": "application/json",
    });
  });

  it("masks API keys for display", () => {
    expect(maskApiKey("sk-abcdefghijklmnop")).toBe("sk-…mnop");
    expect(maskApiKey("short")).toBe("••••••••");
    expect(maskApiKey("")).toBe("");
  });

  it("testConnection succeeds via GET /models", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await testConnection({
      baseUrl: "https://api.openai.com/v1/",
      apiKey: "sk-test",
    });

    expect(result).toEqual({ ok: true, via: "models", modelCount: 2 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/models");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        Authorization: "Bearer sk-test",
      },
    });
  });

  it("testConnection falls back to chat when /models is 404", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/models")) {
        return new Response("missing", { status: 404 });
      }
      return Response.json({ choices: [{ message: { role: "assistant", content: "pong" } }] });
    });

    const result = await testConnection(
      {
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test",
        defaultModel: "custom-model",
      },
      fetchMock as typeof fetch,
    );

    expect(result).toEqual({ ok: true, via: "chat" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const chatCall = fetchMock.mock.calls[1];
    expect(chatCall?.[0]).toBe("https://api.example.com/v1/chat/completions");
    expect(JSON.parse(String(chatCall?.[1]?.body))).toMatchObject({
      model: "custom-model",
      max_tokens: 1,
    });
  });

  it("testConnection reports auth failures clearly", async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"invalid_api_key"}', { status: 401 }));

    const result = await testConnection(
      { baseUrl: "https://api.openai.com/v1", apiKey: "bad" },
      fetchMock as typeof fetch,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("鉴权失败");
      expect(result.message).toContain("401");
    }
  });

  it("testConnection validates required fields", async () => {
    expect(await testConnection({ baseUrl: "", apiKey: "sk" })).toEqual({
      ok: false,
      message: "请填写 Base URL",
    });
    expect(await testConnection({ baseUrl: "https://x/v1", apiKey: "  " })).toEqual({
      ok: false,
      message: "请填写 API Key",
    });
  });
});

const credentials = { baseUrl: " https://api.example.test/v1/ ", apiKey: " fixture-secret " };
const chatSuccess = async () => Response.json({ choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }] });
const operations = [
  ["list", listModels],
  ["probe", testConnection],
] as const;

function brokenBody(error: Error): Response {
  const response = Response.json({ data: [] });
  vi.spyOn(response, "json").mockRejectedValue(error);
  return response;
}

const badDirectories: Array<[string, () => Response]> = [
  ["HTML", () => new Response("<html>login</html>")],
  ["truncated JSON", () => new Response('{"data":')],
  ["empty body", () => new Response(null, { status: 204 })],
  ...[
    ["missing data", {}], ["null envelope", null], ["array envelope", []],
    ["object data", { data: {} }], ["null data", { data: null }],
    ["error", { error: { message: "invalid fixture-secret" } }],
    ["error with empty data", { error: "denied", data: [] }],
    ["error with valid data", { error: { message: "denied" }, data: [{ id: "valid" }] }],
    ["false error", { error: false, data: [] }],
    ["success false", { success: false, data: [] }],
    ["null row", { data: [null] }], ["array row", { data: [[]] }],
    ["missing ID", { data: [{}] }], ["number ID", { data: [{ id: 4 }] }],
    ["blank ID", { data: [{ id: " \t " }] }],
    ["mixed valid and invalid rows", { data: [{ id: "valid" }, {}] }],
  ].map(([name, body]) => [name as string, () => Response.json(body)] as [string, () => Response]),
  ["body TypeError", () => brokenBody(new TypeError("body fixture-secret"))],
  ["body SyntaxError", () => brokenBody(new SyntaxError("body fixture-secret"))],
  ["body AbortError", () => brokenBody(new DOMException("body fixture-secret", "AbortError"))],
];

function expectMethods(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, methods: string[]) {
  expect(fetchImpl).toHaveBeenCalledTimes(methods.length);
  expect(fetchImpl.mock.calls.map(call => call[1]?.method)).toEqual(methods);
}

for (const [name, operation] of operations) {
  describe(`${name} model directory boundary`, () => {
    it.each(badDirectories)("rejects %s with one GET and no POST", async (_label, response) => {
      // An accidental paid fallback succeeds, so both result and request count catch it.
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => init?.method === "POST" ? chatSuccess() : response());
      const result = await operation(credentials, fetchImpl);
      expect(result).toMatchObject({ ok: false, message: expect.any(String) });
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
      expectMethods(fetchImpl, ["GET"]);
    });

    it.each([{ data: [] }, { error: null, data: [] }])("accepts a valid empty directory %j", async body => {
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(body));
      expect(await operation(credentials, fetchImpl)).toEqual(name === "list"
        ? { ok: true, models: [] } : { ok: true, via: "models", modelCount: 0 });
      expectMethods(fetchImpl, ["GET"]);
    });

    it("preserves sorted unique IDs and the raw row count without requiring content type", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        data: [{ id: " z " }, { id: "a" }, { id: "a" }],
      }), { headers: { "Content-Type": "text/plain" } }));
      expect(await operation(credentials, fetchImpl)).toEqual(name === "list"
        ? { ok: true, models: ["a", "z"] } : { ok: true, via: "models", modelCount: 3 });
      expectMethods(fetchImpl, ["GET"]);
    });

    it.each([400, 401, 403, 408, 429, 500, 503])("fails HTTP %s without POST", async status => {
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => init?.method === "POST" ? chatSuccess() : new Response("denied fixture-secret", { status }));
      const result = await operation(credentials, fetchImpl);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
      expectMethods(fetchImpl, ["GET"]);
    });

    it.each([new Error("network"), new SyntaxError("network"), new DOMException("abort", "AbortError")])("fails fetch $name without POST", async error => {
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        if (init?.method === "POST") return chatSuccess();
        throw error;
      });
      expect((await operation(credentials, fetchImpl)).ok).toBe(false);
      expectMethods(fetchImpl, ["GET"]);
    });

    it.each([
      { baseUrl: "  ", apiKey: "fixture" },
      { baseUrl: "https://example.test/v1", apiKey: "  " },
    ])("rejects missing credentials before fetch %j", async input => {
      const fetchImpl = vi.fn<typeof fetch>();
      expect((await operation(input, fetchImpl)).ok).toBe(false);
      expectMethods(fetchImpl, []);
    });
  });
}

const fallbackGates: Array<[string, () => Promise<Response>]> = [
  ["404", async () => new Response("missing", { status: 404 })],
  ["405", async () => new Response("missing", { status: 405 })],
  ["fetch TypeError", async () => { throw new TypeError("fetch rejected"); }],
];

const badChatBodies: Array<[string, () => Response]> = [
  ["HTML", () => new Response("<html>login</html>")],
  ["bad JSON", () => new Response('{"choices":')],
  ...[
    ["null", null], ["array", []], ["id only", { id: "reply" }],
    ["error", { error: { message: "invalid fixture-secret" } }],
    ["error plus choices", { error: "denied fixture-secret", choices: [{ message: { role: "assistant", content: "pong" } }] }],
    ["success false", { success: false, choices: [{ message: { role: "assistant", content: "pong" } }] }],
    ["object choices", { choices: {} }], ["empty choices", { choices: [] }],
    ["null choice", { choices: [null] }], ["array choice", { choices: [[]] }],
    ["missing message", { choices: [{}] }], ["null message", { choices: [{ message: null }] }],
    ["string message", { choices: [{ message: "pong" }] }],
    ["array message", { choices: [{ message: [] }] }],
    ["empty message", { choices: [{ message: {} }] }],
    ["wrong role", { choices: [{ message: { role: "user", content: "pong" } }] }],
    ["number content", { choices: [{ message: { role: "assistant", content: 7 } }] }],
    ["invalid reasoning", { choices: [{ message: { role: "assistant", reasoning_content: [] } }] }],
  ].map(([name, body]) => [name as string, () => Response.json(body)] as [string, () => Response]),
  ["body TypeError", () => brokenBody(new TypeError("body fixture-secret"))],
  ["body SyntaxError", () => brokenBody(new SyntaxError("body fixture-secret"))],
  ["body AbortError", () => brokenBody(new DOMException("body fixture-secret", "AbortError"))],
  ["HTTP 401", () => new Response("denied fixture-secret", { status: 401 })],
  ["HTTP 500", () => new Response("denied fixture-secret", { status: 500 })],
];

for (const [gate, getResponse] of fallbackGates) {
  describe(`chat fallback after ${gate}`, () => {
    it.each([" custom-model ", "  "])("sends one original minimal POST with model %j", async defaultModel => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(getResponse).mockImplementation(chatSuccess);
      expect(await testConnection({ ...credentials, defaultModel }, fetchImpl)).toEqual({ ok: true, via: "chat" });
      expectMethods(fetchImpl, ["GET", "POST"]);
      expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
        "https://api.example.test/v1/models", "https://api.example.test/v1/chat/completions",
      ]);
      for (const call of fetchImpl.mock.calls) {
        expect(new Headers(call[1]?.headers).get("Authorization")).toBe("Bearer fixture-secret");
        expect(new Headers(call[1]?.headers).get("Content-Type")).toBe("application/json");
      }
      expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
        model: defaultModel.trim() || "gpt-4o-mini", messages: [{ role: "user", content: "ping" }], max_tokens: 1,
      });
    });

    it.each(["", null, undefined])("allows legitimate one-token empty output %j", async content => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(getResponse).mockImplementation(async () => Response.json({
        choices: [{ message: { role: "assistant", ...(content !== undefined ? { content } : {}) }, finish_reason: "length" }],
      }));
      expect(await testConnection(credentials, fetchImpl)).toEqual({ ok: true, via: "chat" });
      expectMethods(fetchImpl, ["GET", "POST"]);
    });

    it.each(badChatBodies)("rejects POST %s without a second POST", async (_label, response) => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(getResponse)
        .mockImplementationOnce(async () => response()).mockImplementation(chatSuccess);
      const result = await testConnection(credentials, fetchImpl);
      expect(result).toMatchObject({ ok: false, message: expect.any(String) });
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
      expectMethods(fetchImpl, ["GET", "POST"]);
    });

    it.each([new TypeError("fetch fixture-secret"), new Error("fetch fixture-secret"), new DOMException("fetch fixture-secret", "AbortError")])("never retries POST fetch $name", async error => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(getResponse)
        .mockRejectedValueOnce(error).mockImplementation(chatSuccess);
      const result = await testConnection(credentials, fetchImpl);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
      expectMethods(fetchImpl, ["GET", "POST"]);
    });
  });
}

it.each(fallbackGates)("listModels never falls back after %s", async (_label, getResponse) => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(getResponse).mockImplementation(chatSuccess);
  expect((await listModels(credentials, fetchImpl)).ok).toBe(false);
  expectMethods(fetchImpl, ["GET"]);
});

it.each(operations)("%s redacts complete diagnostics before truncating", async (_label, operation) => {
  const secret = "long-secret-that-crosses-the-truncation-boundary";
  const prefix = "x".repeat(285);
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: { message: prefix + secret } }));
  const result = await operation({ ...credentials, apiKey: secret }, fetchImpl);
  expect(result).toEqual({ ok: false, message: prefix + "[已隐藏]" });
  expectMethods(fetchImpl, ["GET"]);
});
