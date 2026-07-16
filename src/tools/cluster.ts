/**
 * Cluster-wide insight.
 *
 *   • cluster_status    — quorum and membership (nodes, cluster health).
 *   • cluster_resources — a single view of nodes, guests and storage.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { z } from "zod";
import type { ToolContext } from "./context.js";
import { asJsonBlock, formatBytes, formatPercent, renderTable, truncate } from "../utils/format.js";
import { guard, ok } from "../utils/result.js";

export function registerClusterTools({ server, proxmox }: ToolContext): void {
  server.registerTool(
    "cluster_status",
    {
      title: "Cluster status",
      description:
        "Report cluster membership and quorum: each node's online state and " +
        "whether the cluster is quorate. On a single node it reports standalone.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const status = await proxmox.clusterStatus();
        return ok(asJsonBlock(status));
      }),
  );

  server.registerTool(
    "cluster_resources",
    {
      title: "Cluster resources",
      description:
        "A single consolidated view of the cluster's resources — nodes, VMs, " +
        "containers and storage — with status and utilisation. Filter by type.",
      inputSchema: {
        type: z
          .enum(["node", "vm", "storage", "sdn"])
          .optional()
          .describe("Restrict to one resource type."),
      },
    },
    async ({ type }) =>
      guard(async () => {
        const res = await proxmox.clusterResources(type);
        const rows = (res ?? []).map((r) => [
          String(r.type ?? ""),
          truncate(String(r.name ?? r.node ?? r.vmid ?? ""), 24),
          String(r.node ?? "—"),
          String(r.status ?? "—"),
          r.cpu !== undefined ? formatPercent(Number(r.cpu)) : "—",
          r.maxmem ? `${formatBytes(Number(r.mem ?? 0))}/${formatBytes(Number(r.maxmem))}` : "—",
        ]);
        const table = renderTable(["TYPE", "NAME", "NODE", "STATUS", "CPU", "MEMORY"], rows);
        return ok(`${res?.length ?? 0} resource(s).\n\n${table}`);
      }),
  );
}
