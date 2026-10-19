import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  createSerialQueue,
  DEFAULT_TOOL_TIMEOUT_MS,
  createToolExecutor,
  type ToolExecutedEvent,
} from "../toolExecutor.js";
import type { ToolExecutionContext, ToolHandler } from "../surface.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function setup(
  handlers: Record<string, ToolHandler>,
  opts: { timeoutMs?: number; readOnly?: string[] } = {},
) {
  const events: ToolExecutedEvent[] = [];
  const runSerialized = createSerialQueue();
  const execute = createToolExecutor<ToolExecutionContext, string>({
    resolveHandler: (name) => handlers[name],
    runQueued: (name, task) => (opts.readOnly?.includes(name) ? task() : runSerialized(task)),
    timeoutMs: () => opts.timeoutMs ?? 1000,
    onExecuted: (e) => events.push(e),
  });
  return { execute, events };
}

describe("createToolExecutor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the handler result and reports ok", async () => {
    const { execute, events } = setup({ t: async (args) => `got ${JSON.stringify(args)}` });
    await expect(execute("t", { a: 1 }, undefined, "chat")).resolves.toBe('got {"a":1}');
    expect(events).toMatchObject([{ toolName: "t", ok: true, source: "chat" }]);
    expect(events[0].errorKind).toBeUndefined();
  });

  it("reports an unknown tool without running anything", async () => {
    const { execute, events } = setup({});
    await expect(execute("nope", {}, undefined, "bridge")).resolves.toBe(
      JSON.stringify({ error: "Unknown tool: nope" }),
    );
    expect(events).toMatchObject([{ ok: false, errorKind: "unknown_tool" }]);
  });

  it("uses a custom unknown-tool result", async () => {
    const execute = createToolExecutor<ToolExecutionContext>({
      resolveHandler: () => undefined,
      timeoutMs: () => 10,
      unknownToolResult: (n) => `custom ${n}`,
    });
    await expect(execute("q", {}, undefined, "x")).resolves.toBe("custom q");
  });

  it("flags handler-reported errors and thrown errors", async () => {
    const { execute, events } = setup({
      soft: async () => '{"error":"bad"}',
      hard: async () => {
        throw new Error("boom");
      },
    });
    await expect(execute("soft", {}, undefined, "chat")).resolves.toBe('{"error":"bad"}');
    await expect(execute("hard", {}, undefined, "chat")).resolves.toBe('{"error":"boom"}');
    expect(events.map((e) => e.errorKind)).toEqual(["handler_error", "handler_error"]);
  });

  it("times out, aborts the handler signal and reports timeout", async () => {
    let seen: AbortSignal | undefined;
    const { execute, events } = setup(
      {
        slow: (_a, ctx) => {
          seen = ctx?.signal;
          return new Promise<string>(() => {});
        },
      },
      { timeoutMs: 500 },
    );
    const p = execute("slow", {}, undefined, "chat");
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toBe('{"error":"Tool call timed out"}');
    expect(seen?.aborted).toBe(true);
    expect(events[0].errorKind).toBe("timeout");
  });

  it("propagates the caller's abort to the handler signal", async () => {
    let seen: AbortSignal | undefined;
    const { execute } = setup({
      t: async (_a, ctx) => {
        seen = ctx?.signal;
        return "done";
      },
    });
    const caller = new AbortController();
    await execute("t", {}, { signal: caller.signal }, "chat");
    expect(seen?.aborted).toBe(false);
    caller.abort();
    expect(seen?.aborted).toBe(true);
  });

  it("passes the rest of the context through untouched", async () => {
    let seen: ToolExecutionContext | undefined;
    const { execute } = setup({
      t: async (_a, ctx) => {
        seen = ctx;
        return "ok";
      },
    });
    await execute("t", {}, { sessionId: "s", toolCallId: "c" }, "chat");
    expect(seen).toMatchObject({ sessionId: "s", toolCallId: "c" });
  });

  it("serializes queued tools, lets read-only tools bypass, and starts the timeout after the wait", async () => {
    const gate = deferred<string>();
    const order: string[] = [];
    const { execute } = setup(
      {
        w1: async () => {
          order.push("w1 start");
          const r = await gate.promise;
          order.push("w1 end");
          return r;
        },
        w2: async () => {
          order.push("w2 start");
          return "w2";
        },
        r: async () => {
          order.push("r");
          return "r";
        },
      },
      { readOnly: ["r"], timeoutMs: 1000 },
    );
    const p1 = execute("w1", {}, undefined, "chat");
    const p2 = execute("w2", {}, undefined, "chat");
    const p3 = execute("r", {}, undefined, "chat");
    await vi.advanceTimersByTimeAsync(0);
    // The read-only call ran while w1 is still pending; w2 has not started.
    expect([...order].sort()).toEqual(["r", "w1 start"]);
    // w2 waits 900ms in the queue, then still gets its own full budget.
    await vi.advanceTimersByTimeAsync(900);
    gate.resolve("w1");
    await vi.advanceTimersByTimeAsync(0);
    await expect(p1).resolves.toBe("w1");
    await expect(p2).resolves.toBe("w2");
    await expect(p3).resolves.toBe("r");
    expect(order.slice(2)).toEqual(["w1 end", "w2 start"]);
  });
});

describe("createToolExecutor onExecuted hook", () => {
  const throwing = () => {
    throw new Error("hook failed");
  };

  it("keeps a successful result and emits once when the hook throws", async () => {
    const emit = vi.fn(throwing);
    const execute = createToolExecutor<ToolExecutionContext, string>({
      resolveHandler: () => async () => "fine",
      timeoutMs: () => 1000,
      onExecuted: emit,
    });
    await expect(execute("t", {}, undefined, "chat")).resolves.toBe("fine");
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("resolves when the hook throws on the unknown-tool path", async () => {
    const execute = createToolExecutor<ToolExecutionContext, string>({
      resolveHandler: () => undefined,
      timeoutMs: () => 1000,
      onExecuted: throwing,
    });
    await expect(execute("nope", {}, undefined, "chat")).resolves.toBe(
      JSON.stringify({ error: "Unknown tool: nope" }),
    );
  });

  it("resolves when the hook throws on the handler-error path", async () => {
    const emit = vi.fn(throwing);
    const execute = createToolExecutor<ToolExecutionContext, string>({
      resolveHandler: () => async () => {
        throw new Error("boom");
      },
      timeoutMs: () => 1000,
      onExecuted: emit,
    });
    await expect(execute("t", {}, undefined, "chat")).resolves.toBe('{"error":"boom"}');
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe("createToolExecutor timeout budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function slowExecutor(timeoutMs: () => number) {
    let handlerRan = false;
    const execute = createToolExecutor<ToolExecutionContext, string>({
      resolveHandler: () => () => {
        handlerRan = true;
        return new Promise<string>(() => {});
      },
      timeoutMs,
    });
    return { execute, ran: () => handlerRan };
  }

  it("falls back to the default when timeoutMs throws, before the handler runs", async () => {
    const { execute, ran } = slowExecutor(() => {
      throw new Error("no budget");
    });
    const p = execute("t", {}, undefined, "chat");
    await vi.advanceTimersByTimeAsync(DEFAULT_TOOL_TIMEOUT_MS - 1);
    expect(ran()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('{"error":"Tool call timed out"}');
  });

  it("passes the caller context to timeoutMs", async () => {
    const seen: unknown[] = [];
    const execute = createToolExecutor<ToolExecutionContext, string>({
      resolveHandler: () => async () => "ok",
      timeoutMs: (name, input, context) => {
        seen.push([name, input, context]);
        return 1000;
      },
    });
    const ctx: ToolExecutionContext = { signal: new AbortController().signal };
    await expect(execute("t", { a: 1 }, ctx, "chat")).resolves.toBe("ok");
    await execute("t", {}, undefined, "chat");
    expect(seen).toEqual([
      ["t", { a: 1 }, ctx],
      ["t", {}, undefined],
    ]);
    expect((seen[0] as unknown[])[2]).toBe(ctx);
  });

  it.each([NaN, undefined, 0, -5, Infinity])("falls back to the default for %s", async (value) => {
    const { execute } = slowExecutor(() => value as number);
    const p = execute("t", {}, undefined, "chat");
    await vi.advanceTimersByTimeAsync(DEFAULT_TOOL_TIMEOUT_MS);
    await expect(p).resolves.toBe('{"error":"Tool call timed out"}');
  });
});

describe("createSerialQueue", () => {
  it("keeps running after a task rejects", async () => {
    const run = createSerialQueue();
    await expect(run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(run(async () => "next")).resolves.toBe("next");
  });
});
