import { describe, it, expect, vi } from "vitest";
import { createHarnessTransport } from "../transport.js";

function okFetch() {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
}

async function send(
  fetchImpl: ReturnType<typeof okFetch>,
  extra: Partial<Parameters<typeof createHarnessTransport>[0]> = {},
) {
  const transport = createHarnessTransport({
    api: "http://localhost/api/chat",
    body: () => ({ model: "m", canvasContext: "ctx" }),
    fetchImpl,
    ...extra,
  });
  await transport.sendMessages({
    chatId: "chat-1",
    messageId: undefined,
    trigger: "submit-message",
    messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
    abortSignal: undefined,
  });
  const init = fetchImpl.mock.calls[0][1] as RequestInit;
  return { init, body: JSON.parse(init.body as string), headers: new Headers(init.headers) };
}

describe("createHarnessTransport", () => {
  it("merges the body provider with id/messages/trigger", async () => {
    const { body } = await send(okFetch());
    expect(body).toMatchObject({ id: "chat-1", model: "m", canvasContext: "ctx", trigger: "submit-message" });
    expect(body.messages).toHaveLength(1);
  });

  it("adds headers from extraHeaders, decided from the outgoing body", async () => {
    const extraHeaders = vi.fn((b: Record<string, unknown> | undefined) =>
      b?.model === "m" ? { "X-Test": "1" } : undefined,
    );
    const { headers } = await send(okFetch(), { extraHeaders });
    expect(headers.get("x-test")).toBe("1");
    expect(extraHeaders).toHaveBeenCalledWith(expect.objectContaining({ model: "m" }));
  });

  it("sends no extra header when the hook returns undefined", async () => {
    const { headers } = await send(okFetch(), { extraHeaders: () => undefined });
    expect(headers.get("x-test")).toBeNull();
  });

  it("applies wrapFetch around the retrying fetch", async () => {
    const wrapped = vi.fn();
    const f = okFetch();
    await send(f, {
      wrapFetch: (inner) => (input, init) => {
        wrapped();
        return inner(input, init);
      },
    });
    expect(wrapped).toHaveBeenCalledOnce();
    expect(f).toHaveBeenCalledOnce();
  });

  it("surfaces the offline message instead of retrying", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const transport = createHarnessTransport({
      api: "http://localhost/api/chat",
      body: () => ({}),
      fetchImpl: f as unknown as typeof fetch,
      isOffline: () => true,
      offlineMessage: "Offline.",
    });
    await expect(
      transport.sendMessages({
        chatId: "c",
        messageId: undefined,
        trigger: "submit-message",
        messages: [],
        abortSignal: undefined,
      }),
    ).rejects.toThrow("Offline.");
    expect(f).toHaveBeenCalledOnce();
  });
});
