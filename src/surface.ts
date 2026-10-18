import type { ComponentType } from "react";

/** Per-call context handed to a tool handler. Apps extend it with their own fields. */
export interface ToolExecutionContext {
  sessionId?: string;
  toolCallId?: string;
  /** Aborts when the turn is stopped or the call times out. */
  signal?: AbortSignal;
}

export type ToolHandler<Ctx extends ToolExecutionContext = ToolExecutionContext> = (
  args: Record<string, unknown>,
  context?: Ctx,
) => Promise<string>;

/**
 * A Surface is the thing the agent works on (a canvas, a document, a browser).
 * It owns a set of client-executed tools and says how the agent perceives it.
 */
export interface Surface<Ctx extends ToolExecutionContext = ToolExecutionContext> {
  id: string;
  title: string;
  /** Tools this surface owns, keyed by tool name. */
  tools: Record<string, ToolHandler<Ctx>>;
  /** Per-turn context sent to the agent. */
  buildContext?: (sessionId: string) => Record<string, unknown>;
  /** How the agent "sees" the surface. */
  snapshot?: (ctx?: Ctx) => Promise<string>;
  /** Main-area view. */
  View?: ComponentType;
}

/**
 * Merge the tools of several surfaces (plus optional shared tools) into one
 * registry. Throws when two sources define the same tool name: a silent
 * override would make the agent run the wrong surface's handler.
 */
export function composeToolHandlers<Ctx extends ToolExecutionContext = ToolExecutionContext>(
  surfaces: ReadonlyArray<Pick<Surface<Ctx>, "id" | "tools">>,
  shared: Record<string, ToolHandler<Ctx>> = {},
): Record<string, ToolHandler<Ctx>> {
  const merged: Record<string, ToolHandler<Ctx>> = {};
  const owner: Record<string, string> = {};
  const add = (source: string, tools: Record<string, ToolHandler<Ctx>>) => {
    for (const [name, handler] of Object.entries(tools)) {
      if (Object.prototype.hasOwnProperty.call(merged, name)) {
        throw new Error(`Duplicate tool "${name}": defined by "${owner[name]}" and "${source}"`);
      }
      merged[name] = handler;
      owner[name] = source;
    }
  };
  add("shared", shared);
  for (const surface of surfaces) add(surface.id, surface.tools);
  return merged;
}
