/**
 * MCP tool-result helpers.
 *
 * Every tool returns the same `{ content: [...] }` shape. These wrappers keep
 * call sites terse and surface errors as `isError` text the LLM can react to.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

/** The subset of the MCP tool-result shape this server produces. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** Build a successful text result. */
export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Build an error text result the LLM can read and recover from. */
export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Wrap an async tool handler so thrown errors become clean `fail(...)`. */
export function guard(handler: () => Promise<ToolResult>): Promise<ToolResult> {
  return handler().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    return fail(message);
  });
}
