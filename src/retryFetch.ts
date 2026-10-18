// Client-side auto-retry for chat requests, covering two failure classes:
//
// 1. Transport-level failures: fetch rejects before any response arrives,
//    surfaced by browsers as a TypeError (e.g. "Failed to fetch" / "Load
//    failed" / "NetworkError" — exact wording varies by browser and there's
//    no reliable way to distinguish transient from permanent ones).
// 2. Retryable HTTP responses: the request completed but the server
//    signalled a transient failure it is safe to re-send, optionally overridden
//    by an `x-should-retry` response header and/or a server-requested delay
//    (`retry-after-ms` or `Retry-After`). Policy ported from pi's
//    provider-retry (earendil-works/pi, MIT).
//
// INVARIANT: a retry decision is only ever made from a response that has
// not started streaming to the caller yet — this function either returns a
// Response immediately (success, or a non-retryable/exhausted failure) or
// loops internally to fetch again; it never restarts a response body the
// caller has begun reading. A 200 is always returned on the first
// successful fetch and never re-fetched — re-running a chat turn after
// tokens/tool-calls have started streaming would re-execute tool calls
// against the scene graph. A non-2xx body we've decided to retry is
// explicitly cancelled (`response.body?.cancel()`) before retrying so the
// connection isn't leaked.
export interface RetryState {
  /** The retry about to run, 1-based. */
  attempt: number;
  /** Max retries after the initial failure. */
  maxAttempts: number;
  /** Why this retry is happening. Optional — existing consumers only care
   *  that a retry is in flight, not why. */
  reason?: "network" | "http-status";
  /** How long we wait before this retry runs, in ms. Variable now that the
   *  backoff is exponential and the server can name its own delay, so the
   *  UI has to read it rather than assume a constant. */
  delayMs?: number;
}

export const RETRY_MAX_ATTEMPTS = 3;
// Base delay for the exponential backoff (ms). The delay for retry attempt N
// (1-based) is `RETRY_DELAY_MS * 2 ** (N - 1)`, jittered down by up to 25%,
// and capped at RETRY_MAX_DELAY_MS — unless the server names its own delay
// via retry-after-ms/Retry-After, which is used instead (see decideHttpRetry).
export const RETRY_DELAY_MS = 1000;
export const RETRY_MAX_DELAY_MS = 30_000;

/** HTTP statuses that mean "we did not run your turn — send it again".
 *  Deliberately narrow: `POST /api/chat` is NOT idempotent, and 500/502/504
 *  usually mean the server *did* start the turn (a crash mid-turn, or a
 *  gateway timeout while the LLM was already streaming). Re-sending those
 *  would run a second paid agent turn against the same message, duplicate
 *  trace rows, and — with 3 retries — could quadruple the spend of one
 *  stuck request. 408/429/503 are refusals issued before any work starts
 *  (request timeout, our own rate limiter, service unavailable). A backend
 *  that knows its failure was work-free can always opt in explicitly with
 *  `x-should-retry: true`. */
const RETRYABLE_STATUSES = new Set([408, 429, 503]);

export interface RetryingFetchOptions {
  maxAttempts?: number;
  /** Base backoff delay in ms (see RETRY_DELAY_MS). */
  delayMs?: number;
  onRetryStateChange: (state: RetryState | null) => void;
  fetchImpl?: typeof fetch;
  /** When set and it returns true after a transport failure, stop retrying
   *  and throw `new Error(offlineMessage)` instead. */
  isOffline?: () => boolean;
  offlineMessage?: string;
}

export function createRetryingFetch(options: RetryingFetchOptions): typeof fetch {
  const {
    maxAttempts = RETRY_MAX_ATTEMPTS,
    delayMs: baseDelayMs = RETRY_DELAY_MS,
    onRetryStateChange,
    fetchImpl,
    isOffline,
    offlineMessage = "You are offline.",
  } = options;

  return async function retryingFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let retriesDone = 0;

    for (;;) {
      let response: Response;
      try {
        // Resolved per call so vi.stubGlobal("fetch", ...) in hook tests is
        // honored even when the wrapper was created earlier.
        const doFetch = fetchImpl ?? globalThis.fetch;
        response = await doFetch(input, init);
      } catch (err) {
        const wouldRetry = err instanceof TypeError && signal?.aborted !== true;
        if (wouldRetry && isOffline?.() === true) {
          onRetryStateChange(null);
          throw new Error(offlineMessage, { cause: err });
        }
        const retryable = wouldRetry && retriesDone < maxAttempts;
        if (!retryable) {
          onRetryStateChange(null);
          throw err;
        }
        retriesDone += 1;
        const networkDelayMs = computeBackoffDelayMs(baseDelayMs, retriesDone);
        onRetryStateChange({
          attempt: retriesDone,
          maxAttempts,
          reason: "network",
          delayMs: networkDelayMs,
        });
        try {
          await abortableDelay(networkDelayMs, signal);
        } catch (abortErr) {
          onRetryStateChange(null);
          throw abortErr;
        }
        continue;
      }

      if (response.ok) {
        // Success is returned immediately and never retried — see the
        // module-level invariant.
        onRetryStateChange(null);
        return response;
      }

      const decision = decideHttpRetry(response, retriesDone, maxAttempts, baseDelayMs);
      if (!decision.retry) {
        onRetryStateChange(null);
        return response;
      }

      // We're about to retry: the caller never sees this body, so close it
      // out to avoid leaking the connection.
      await response.body?.cancel().catch(() => {});

      retriesDone += 1;
      onRetryStateChange({
        attempt: retriesDone,
        maxAttempts,
        reason: "http-status",
        delayMs: decision.delayMs,
      });
      try {
        await abortableDelay(decision.delayMs, signal);
      } catch (abortErr) {
        onRetryStateChange(null);
        throw abortErr;
      }
    }
  };
}

interface HttpRetryDecision {
  retry: boolean;
  delayMs: number;
}

function decideHttpRetry(
  response: Response,
  retriesDone: number,
  maxAttempts: number,
  baseDelayMs: number,
): HttpRetryDecision {
  if (retriesDone >= maxAttempts) return { retry: false, delayMs: 0 };

  const shouldRetryHeader = response.headers.get("x-should-retry");
  const wantsRetry =
    shouldRetryHeader === "true"
      ? true
      : shouldRetryHeader === "false"
        ? false
        : RETRYABLE_STATUSES.has(response.status);
  if (!wantsRetry) return { retry: false, delayMs: 0 };

  const serverDelayMs = parseRetryDelayMs(response.headers);
  if (serverDelayMs !== null) {
    // The server asked for a delay longer than we're willing to wait — give
    // up and hand the response back rather than retry.
    if (serverDelayMs > RETRY_MAX_DELAY_MS) return { retry: false, delayMs: 0 };
    return { retry: true, delayMs: serverDelayMs };
  }

  return { retry: true, delayMs: computeBackoffDelayMs(baseDelayMs, retriesDone + 1) };
}

/** `retry-after-ms` (ms, non-standard) takes priority, then the standard
 *  `Retry-After` header, which may be either a number of seconds or an
 *  HTTP-date. Returns null if neither header is present/parseable. */
function parseRetryDelayMs(headers: Headers): number | null {
  // `Number("")` and `Number("   ")` are 0, not NaN — an empty or blank
  // header must read as "absent" (fall through to our own backoff), not as
  // "retry immediately", which would fire every attempt back-to-back.
  const msHeader = headers.get("retry-after-ms")?.trim();
  if (msHeader) {
    const ms = Number(msHeader);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }

  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) {
      return Math.max(0, dateMs - Date.now());
    }
  }

  return null;
}

/** Exponential backoff with jitter: base * 2^(attempt-1), reduced by up to
 *  25% at random, capped at RETRY_MAX_DELAY_MS. `attempt` is 1-based. */
function computeBackoffDelayMs(base: number, attempt: number): number {
  const exp = base * 2 ** (attempt - 1);
  const jittered = exp * (1 - Math.random() * 0.25);
  return Math.min(jittered, RETRY_MAX_DELAY_MS);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The operation was aborted.", "AbortError")
  );
}
