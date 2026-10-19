import type { ToolExecutionContext, ToolHandler } from "./surface.js";

/**
 * Serial queue. Tasks run one at a time in submission order; a failed task
 * does not block the ones behind it.
 */
export function createSerialQueue() {
  let queue: Promise<unknown> = Promise.resolve();
  return function runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export type ToolErrorKind = "unknown_tool" | "handler_error" | "timeout";

export interface ToolExecutedEvent<Source extends string = string> {
  toolName: string;
  ok: boolean;
  durationMs: number;
  errorKind?: ToolErrorKind;
  source: Source;
}

export const TOOL_TIMEOUT_MESSAGE = "Tool call timed out";

/** Budget used when `timeoutMs` throws or returns a non-finite or non-positive number. */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export interface ToolExecutorOptions<Ctx extends ToolExecutionContext, Source extends string> {
  resolveHandler: (toolName: string) => ToolHandler<Ctx> | undefined;
  /**
   * Queue policy. Receives the task for one call and returns its result.
   * The timeout starts inside the task, so queue wait time is not charged to
   * the call. Default: run immediately.
   */
  runQueued?: <T>(toolName: string, task: () => Promise<T>) => Promise<T>;
  /**
   * Timeout budget for one call, in ms. Read before the handler runs. If it
   * throws or returns a non-finite or non-positive number, the executor uses
   * DEFAULT_TOOL_TIMEOUT_MS. `context` is the caller's execution context as
   * passed to `execute` (not the merged-signal copy the handler gets), or
   * undefined when the caller passed none.
   */
  timeoutMs: (toolName: string, input: Record<string, unknown>, context: Ctx | undefined) => number;
  /** Result string for a tool name with no handler. */
  unknownToolResult?: (toolName: string) => string;
  /** Observer. Errors it throws are swallowed: it can never change a call's result. */
  onExecuted?: (event: ToolExecutedEvent<Source>) => void;
}

/**
 * The single funnel for tool execution. Queues (via `runQueued`), races a
 * timeout, merges the caller's AbortSignal with the timeout signal, and never
 * throws: failures come back as a `{"error": ...}` JSON string.
 */
export function createToolExecutor<Ctx extends ToolExecutionContext, Source extends string = string>(
  options: ToolExecutorOptions<Ctx, Source>,
) {
  const { resolveHandler, runQueued, timeoutMs, onExecuted } = options;
  const unknownToolResult =
    options.unknownToolResult ?? ((name: string) => JSON.stringify({ error: `Unknown tool: ${name}` }));

  return async function execute(
    toolName: string,
    input: unknown,
    context: Ctx | undefined,
    source: Source,
  ): Promise<string> {
    const startedAt = performance.now();
    const emit = (ok: boolean, errorKind?: ToolErrorKind) => {
      try {
        onExecuted?.({
          toolName,
          ok,
          durationMs: Math.round(performance.now() - startedAt),
          ...(errorKind ? { errorKind } : {}),
          source,
        });
      } catch {
        // An observer must not break the never-throws contract.
      }
    };

    const handler = resolveHandler(toolName);
    if (!handler) {
      emit(false, "unknown_tool");
      return unknownToolResult(toolName);
    }
    const args =
      input != null && typeof input === "object" ? (input as Record<string, unknown>) : {};
    let budget = DEFAULT_TOOL_TIMEOUT_MS;
    try {
      const requested = timeoutMs(toolName, args, context);
      if (Number.isFinite(requested) && requested > 0) budget = requested;
    } catch {
      // Keep the default budget.
    }
    let result: string;
    try {
      // Fires on the caller's signal AND on the timeout, so a long tool stops
      // instead of running on after the model was told it timed out.
      const timeoutAbort = new AbortController();
      const signal = context?.signal
        ? AbortSignal.any([context.signal, timeoutAbort.signal])
        : timeoutAbort.signal;
      const handlerContext = { ...context, signal } as Ctx;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const run = () =>
        Promise.race([
          handler(args, handlerContext),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timeoutAbort.abort();
              reject(new Error(TOOL_TIMEOUT_MESSAGE));
            }, budget);
          }),
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        });
      result = await (runQueued ? runQueued(toolName, run) : run());
    } catch (err) {
      emit(false, err instanceof Error && err.message === TOOL_TIMEOUT_MESSAGE ? "timeout" : "handler_error");
      return JSON.stringify({
        error: err instanceof Error ? err.message : "Tool call failed",
      });
    }
    // Handlers report failure as a JSON `{"error": ...}` string. A prefix
    // check avoids JSON.parse on multi-MB results. Emitting after the try
    // block means a hook can neither turn success into an error nor emit twice.
    const ok = !result.startsWith('{"error"');
    emit(ok, ok ? undefined : "handler_error");
    return result;
  };
}
