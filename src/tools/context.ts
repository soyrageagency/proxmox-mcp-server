/**
 * Shared tool context.
 *
 * Bundles the collaborators tools need (Proxmox client, config, logger, and
 * plugin metadata) so each module stays free of global state.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { ProxmoxClient } from "../proxmox/client.js";

/** Lightweight plugin metadata surfaced to tools (e.g. `list_plugins`). */
export interface PluginInfo {
  readonly name: string;
  readonly title: string;
  readonly category: string;
  readonly mutating: boolean;
  readonly enabled: boolean;
}

/** Dependencies handed to each tool group at registration time. */
export interface ToolContext {
  readonly server: McpServer;
  readonly proxmox: ProxmoxClient;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly plugins: readonly PluginInfo[];
}
