import { DefaultChatTransport } from "ai";
import { createRetryingFetch, type RetryState } from "./retryFetch.js";

export interface HarnessTransportOptions {
  /** Chat endpoint URL. */
  api: string;
  /** Extra request body fields, resolved on every send. */
  body: () => object;
  /** Resolved per request. */
  credentials?: () => RequestCredentials;
  /**
   * Extra headers for one request, decided from the outgoing body. Runs on
   * every send, including every tool-loop auto-continuation. Merged on top of
   * the headers the SDK already computed (the SDK would otherwise REPLACE
   * them). Return undefined to add nothing.
   */
  extraHeaders?: (requestBody: Record<string, unknown> | undefined) => Record<string, string> | undefined;
  /** Wraps the retrying fetch, e.g. to attach an auth header at network time. */
  wrapFetch?: (inner: typeof fetch) => typeof fetch;
  onRetryStateChange?: (state: RetryState | null) => void;
  /** Passed to the retrying fetch. */
  isOffline?: () => boolean;
  offlineMessage?: string;
  fetchImpl?: typeof fetch;
}

export function createHarnessTransport(options: HarnessTransportOptions) {
  const { api, body, credentials, extraHeaders, wrapFetch, onRetryStateChange, isOffline, offlineMessage, fetchImpl } =
    options;
  const retrying = createRetryingFetch({
    onRetryStateChange: onRetryStateChange ?? (() => {}),
    isOffline,
    offlineMessage,
    fetchImpl,
  });
  return new DefaultChatTransport({
    api,
    ...(credentials ? { credentials } : {}),
    fetch: wrapFetch ? wrapFetch(retrying) : retrying,
    body,
    prepareSendMessagesRequest: ({ id, messages, body: requestBody, headers: baseHeaders, trigger, messageId }) => {
      const added = extraHeaders?.(requestBody as Record<string, unknown> | undefined);
      // `Headers` accepts every HeadersInit shape, so it merges whatever form
      // the SDK handed us with ours.
      const headers =
        baseHeaders || added
          ? (() => {
              const merged = new Headers(baseHeaders);
              if (added) for (const [key, value] of Object.entries(added)) merged.set(key, value);
              return merged;
            })()
          : undefined;
      return {
        ...(headers ? { headers } : {}),
        body: { ...requestBody, id, messages, trigger, messageId },
      };
    },
  });
}
