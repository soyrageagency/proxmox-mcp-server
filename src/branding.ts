/**
 * Branding & identity.
 *
 * Single source of truth for the project identity carried by the server: the
 * startup banner, the MCP `instructions` payload and the `about` tool.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * MIT licensed (see LICENSE).
 */

/** Identity of the project's author. */
export const BRAND = Object.freeze({
  product: "Proxmox MCP Server",
  author: "SoyRage Agency",
  url: "https://soyrage.es/",
  donate: "https://www.paypal.com/paypalme/soyrageagency",
  tagline: "Chat with your Proxmox VE cluster — safely.",
  version: "1.0.0",
});

/** ASCII welcome banner (ANSI Shadow style). */
export const ASCII_BANNER = String.raw`
 ███████╗ ██████╗ ██╗   ██╗██████╗  █████╗  ██████╗ ███████╗
 ██╔════╝██╔═══██╗╚██╗ ██╔╝██╔══██╗██╔══██╗██╔════╝ ██╔════╝
 ███████╗██║   ██║ ╚████╔╝ ██████╔╝███████║██║  ███╗█████╗
 ╚════██║██║   ██║  ╚██╔╝  ██╔══██╗██╔══██║██║   ██║██╔══╝
 ███████║╚██████╔╝   ██║   ██║  ██║██║  ██║╚██████╔╝███████╗
 ╚══════╝ ╚═════╝    ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝
           P R O X M O X   M C P   S E R V E R
        ~ Chat with your Proxmox VE cluster, safely ~
`;

/** The full welcome block, banner + credits, used by the `about` tool. */
export function welcomeBlock(): string {
  return [
    ASCII_BANNER,
    `  ${BRAND.product} v${BRAND.version}`,
    `  Crafted with care by ${BRAND.author} — ${BRAND.url}`,
    "  Free and open source under the MIT License.",
    `  Support the project: ${BRAND.donate}`,
    "",
  ].join("\n");
}

/**
 * The MCP `instructions` payload — surfaced to the LLM by the client. Keep it
 * strictly operational: what the server can do and how to use it safely.
 */
export function mcpInstructions(): string {
  return [
    `You are connected to "${BRAND.product}", an MCP server for Proxmox VE.`,
    "",
    "CAPABILITIES:",
    "- You can list cluster nodes, QEMU VMs and LXC containers, read their status/config, view storage, tasks and cluster health, and (unless read-only) start/stop/shutdown/reboot guests and create/rollback/delete snapshots.",
    "- A VM/CT is identified by its numeric VMID. Prefer read-only tools to understand state before any action, and confirm destructive actions (stop, rollback_snapshot, delete_snapshot) with the user first — `stop` pulls the virtual power cord, `shutdown` is graceful.",
    "",
    "ABOUT:",
    '- Call the "about" tool if the user asks what this server is, who built it or which version is running.',
  ].join("\n");
}
