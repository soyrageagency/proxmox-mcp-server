/**
 * Task-log insight.
 *
 *   • list_tasks — recent tasks on a node (backups, migrations, actions…).
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { z } from "zod";
import type { ToolContext } from "./context.js";
import { formatUptime, renderTable, truncate } from "../utils/format.js";
import { guard, ok } from "../utils/result.js";

export function registerTaskTools({ server, proxmox }: ToolContext): void {
  server.registerTool(
    "list_tasks",
    {
      title: "List recent tasks",
      description:
        "List the most recent tasks on a node (VM starts, backups, migrations, " +
        "snapshots…) with their type, status and who ran them. Great for " +
        "answering 'what happened on this node lately?'.",
      inputSchema: {
        node: z.string().min(1).describe("Node name (e.g. 'pve')."),
        limit: z.number().int().positive().max(100).optional().describe("How many tasks (default: 25)."),
      },
    },
    async ({ node, limit }) =>
      guard(async () => {
        const tasks = await proxmox.tasks(node, limit ?? 25);
        const now = Math.floor(Date.now() / 1000);
        const rows = (tasks ?? []).map((t) => {
          const start = Number(t.starttime ?? 0);
          const end = Number(t.endtime ?? 0);
          const running = !end;
          const status = running ? "running" : String(t.status ?? "?");
          return [
            truncate(String(t.type ?? ""), 18),
            truncate(String(t.id ?? "—"), 14),
            truncate(String(t.user ?? "—"), 16),
            status === "OK" ? "OK" : truncate(status, 20),
            running ? "—" : formatUptime(now - start) + " ago",
          ];
        });
        const table = renderTable(["TYPE", "ID", "USER", "STATUS", "WHEN"], rows);
        return ok(`Recent tasks on "${node}":\n\n${table}`);
      }),
  );
}
