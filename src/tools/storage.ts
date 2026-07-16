/**
 * Storage insight.
 *
 *   • list_storage — storages available on a node with type, usage and content.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { z } from "zod";
import type { ToolContext } from "./context.js";
import { formatBytes, formatPercent, renderTable, truncate } from "../utils/format.js";
import { guard, ok } from "../utils/result.js";

export function registerStorageTools({ server, proxmox }: ToolContext): void {
  server.registerTool(
    "list_storage",
    {
      title: "List storage",
      description:
        "List the storages configured on a node — type (dir/lvm/zfs/ceph/nfs…), " +
        "what content they hold, and how full they are.",
      inputSchema: {
        node: z.string().min(1).describe("Node name (e.g. 'pve')."),
      },
    },
    async ({ node }) =>
      guard(async () => {
        const storages = await proxmox.storage(node);
        const rows = (storages ?? []).map((s) => {
          const total = Number(s.total ?? 0);
          const used = Number(s.used ?? 0);
          const ratio = total > 0 ? used / total : 0;
          return [
            truncate(String(s.storage ?? ""), 20),
            String(s.type ?? "—"),
            truncate(String(s.content ?? "—"), 26),
            Number(s.active) ? "active" : "inactive",
            total > 0 ? `${formatBytes(used)}/${formatBytes(total)} (${formatPercent(ratio)})` : "—",
          ];
        });
        const table = renderTable(["STORAGE", "TYPE", "CONTENT", "STATE", "USAGE"], rows);
        return ok(`Storage on node "${node}":\n\n${table}`);
      }),
  );
}
