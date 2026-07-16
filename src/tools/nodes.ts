/**
 * Cluster node insight.
 *
 *   • list_nodes  — nodes with online status, CPU and memory load.
 *   • node_status — detailed status of one node (load, uptime, KSM, …).
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { z } from "zod";
import type { ToolContext } from "./context.js";
import { asJsonBlock, formatBytes, formatPercent, formatUptime, renderTable } from "../utils/format.js";
import { guard, ok } from "../utils/result.js";

export function registerNodeTools({ server, proxmox }: ToolContext): void {
  server.registerTool(
    "list_nodes",
    {
      title: "List nodes",
      description:
        "List the Proxmox VE cluster nodes with their online status, CPU load " +
        "and memory usage. The best starting point to understand the cluster.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const nodes = await proxmox.nodes();
        const rows = nodes.map((n) => [
          n.node,
          n.status,
          formatPercent(n.cpu),
          `${formatBytes(n.mem)} / ${formatBytes(n.maxmem)}`,
          formatUptime(n.uptime),
        ]);
        const table = renderTable(["NODE", "STATUS", "CPU", "MEMORY", "UPTIME"], rows);
        return ok(`${nodes.length} node(s).\n\n${table}`);
      }),
  );

  server.registerTool(
    "node_status",
    {
      title: "Node status",
      description:
        "Detailed status for a single node: CPU/memory/swap, load average, " +
        "uptime, kernel and PVE versions.",
      inputSchema: {
        node: z.string().min(1).describe("Node name (e.g. 'pve')."),
      },
    },
    async ({ node }) =>
      guard(async () => {
        const status = await proxmox.get<Record<string, unknown>>(`/nodes/${node}/status`);
        return ok(`Status of node "${node}":\n\n${asJsonBlock(status)}`);
      }),
  );
}
