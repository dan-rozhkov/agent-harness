# @sideform/agent-harness

The client-side agent harness behind Pen Editor. It serves a chat agent whose
tools run in the browser, next to the state they change, while the model runs
on a server.

- **Surface contract.** Each workspace area (a canvas, a browser, a document)
  is a `Surface`. It contributes its tools, optional per-turn context, an
  optional snapshot of how the agent "sees" it, and an optional React view.
- **Tool executor.** One funnel for every tool call: serial queue policy,
  per-call timeout, abort merging. `execute` never throws and never rejects.
- **Chat transport.** A thin layer over the AI SDK `DefaultChatTransport`
  with a retrying `fetch` and a per-request header hook.

Zero app dependencies. Peer dependencies: `ai` (v6) and, for types only,
`react` (optional, used by `Surface.View`).

## Install

```bash
npm install github:dan-rozhkov/agent-harness#v0.1.0
```

The `prepare` script builds `dist/` on install. Requires Node 20 or later.

## Usage

### `@sideform/agent-harness/surface`

```ts
import { composeToolHandlers, type Surface } from "@sideform/agent-harness/surface";

const canvas: Surface = {
  id: "canvas",
  title: "Canvas",
  tools: { add_rect: async (args) => JSON.stringify({ ok: true }) },
  buildContext: (sessionId) => ({ selection: [] }),
};

// Throws on a duplicate tool name instead of silently overriding.
const handlers = composeToolHandlers([canvas, browser], sharedTools);
```

### `@sideform/agent-harness/executor`

```ts
import { createSerialQueue, createToolExecutor } from "@sideform/agent-harness/executor";

const serial = createSerialQueue();
const execute = createToolExecutor({
  resolveHandler: (name) => handlers[name],
  runQueued: (name, task) => (readOnly.has(name) ? task() : serial(task)),
  timeoutMs: (name) => 30_000,
  onExecuted: (e) => console.log(e.toolName, e.ok, e.errorKind, e.durationMs),
});

const result = await execute("add_rect", input, { signal }, "chat"); // always a string
```

The timeout starts when the task starts, so time spent waiting in the queue is
not charged to the call. The handler receives a `signal` that aborts when the
caller aborts or the call times out. If `timeoutMs` throws or returns a
non-finite or non-positive number, the executor uses `DEFAULT_TOOL_TIMEOUT_MS`
(30 seconds).

### `@sideform/agent-harness/retry-fetch`

```ts
import { createRetryingFetch } from "@sideform/agent-harness/retry-fetch";

const f = createRetryingFetch({
  onRetryStateChange: (state) => setBanner(state), // null when done
  isOffline: () => !navigator.onLine,
});
```

It retries transport failures (a `TypeError` from `fetch`) and the HTTP
statuses 408, 429 and 503, with exponential backoff and jitter. A server can
override the decision with `x-should-retry` and name a delay with
`retry-after-ms` or `Retry-After`. A response is only retried before the caller
reads any of its body; a stream that has started is never restarted.

### `@sideform/agent-harness/transport`

```ts
import { createHarnessTransport } from "@sideform/agent-harness/transport";

const transport = createHarnessTransport({
  api: "/api/chat",
  body: () => ({ canvasContext }),
  extraHeaders: (body) => (body?.model ? { "X-Model": String(body.model) } : undefined),
  wrapFetch: (inner) => (input, init) => inner(input, withAuth(init)),
});
// pass `transport` to useChat({ transport })
```

The root entry point re-exports everything.

## Design notes

- **Handlers return strings.** A tool result goes back to the model as text.
  Returning a string keeps the contract the same for every surface and every
  model provider. A handler reports failure as a JSON `{"error": ...}` string;
  the executor detects it with a prefix check, so it does not parse
  multi-megabyte results.
- **`execute` never rejects.** A tool-call loop must always get an answer to
  hand back to the model. A thrown error, a timeout or an unknown tool becomes
  an `{"error": ...}` string. The `onExecuted` observer is also isolated: if it
  throws, the error is swallowed and the result does not change.
- **Keep per-turn context byte-stable.** `Surface.buildContext` output belongs
  in a trailing message, not in the system prompt. Providers cache the request
  prefix; if anything in the prefix changes between tool-loop continuations,
  the cache is lost for everything after it. Build context from state, in a
  deterministic key order, and put it last.

## Development

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

## License

MIT
