/**
 * A tiny, safe "you're out of date" line for the CLI/TUI startup and the MCP
 * server log. Never throws, never blocks longer than its timeout, and writes
 * only a single line — so it can't corrupt JSON-RPC on stdout or a TUI screen.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * MIT licensed (see LICENSE).
 */

import { checkForUpdate } from "./channel.js";
import { BRAND } from "../branding.js";

/** Returns a one-line update notice, or null when up to date / unavailable. */
export async function updateNoticeLine(timeoutMs = 1500): Promise<string | null> {
  try {
    const s = await checkForUpdate({ timeoutMs });
    if (!s?.hasUpdate) return null;
    const rel = s.newer[0];
    const tag = s.critical ? "security update" : "update";
    const link = rel?.url ? `  ${rel.url}` : "";
    return `↑ ${BRAND.product} ${s.latest} is available (${tag}); you have ${s.current}.${link}`;
  } catch {
    return null;
  }
}
