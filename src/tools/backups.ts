/**
 * Backup tools (vzdump).
 *
 * Read-only:
 *   • list_backups   — backup archives on backup-capable storages.
 *
 * State-changing (skipped in read-only mode):
 *   • restore_backup — restore an archive into a VMID (VM or container).
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { z } from "zod";
import type { ToolContext } from "./context.js";
import { formatBytes, formatUptime, renderTable, truncate } from "../utils/format.js";
import { guard, ok, fail } from "../utils/result.js";

/** Extract a short filename from a Proxmox volid. */
function volName(volid: string): string {
  const slash = volid.lastIndexOf("/");
  return slash >= 0 ? volid.slice(slash + 1) : volid;
}

export function registerBackupTools(ctx: ToolContext): void {
  const { server, proxmox, config, logger } = ctx;

  server.registerTool(
    "list_backups",
    {
      title: "List backups",
      description:
        "List vzdump backup archives available on the cluster's backup " +
        "storages, with their VMID, size and age. Filter by node or storage.",
      inputSchema: {
        node: z.string().optional().describe("Node to query (default: first node)."),
        storage: z.string().optional().describe("Only this storage (default: all backup storages)."),
      },
    },
    async ({ node, storage }) =>
      guard(async () => {
        const n = await proxmox.resolveNode(node);
        const storages = storage ? [storage] : await proxmox.backupStorages(n);
        const now = Math.floor(Date.now() / 1000);
        const rows: string[][] = [];
        for (const s of storages) {
          const items = await proxmox.storageContent(n, s, "backup");
          for (const it of items ?? []) {
            rows.push([
              truncate(volName(String(it.volid ?? "")), 42),
              String(it.vmid ?? "—"),
              formatBytes(Number(it.size ?? 0)),
              it.ctime ? formatUptime(now - Number(it.ctime)) + " ago" : "—",
              s,
            ]);
          }
        }
        const table = renderTable(["ARCHIVE", "VMID", "SIZE", "AGE", "STORAGE"], rows);
        return ok(`${rows.length} backup(s):\n\n${table}`);
      }),
  );

  if (config.readOnly) {
    logger.info("Read-only mode: restore_backup is disabled.");
    return;
  }

  server.registerTool(
    "restore_backup",
    {
      title: "Restore backup",
      description:
        "Restore a vzdump archive into a VMID. If the VMID exists you must set " +
        "`force` to overwrite it — DESTRUCTIVE. The guest type (VM/CT) is taken " +
        "from the archive name.",
      inputSchema: {
        volid: z.string().min(1).describe("Backup volume id, e.g. 'nas-backups:backup/vzdump-qemu-101-….vma.zst'."),
        vmid: z.number().int().positive().describe("Target VMID for the restored guest."),
        node: z.string().optional().describe("Node to restore on (default: first node)."),
        storage: z.string().optional().describe("Storage for the restored disks."),
        force: z.boolean().optional().describe("Overwrite an existing VMID (destructive)."),
      },
    },
    async ({ volid, vmid, node, storage, force }) =>
      guard(async () => {
        const n = await proxmox.resolveNode(node);
        const isQemu = /vzdump-qemu-/.test(volid);
        const isLxc = /vzdump-lxc-/.test(volid);
        if (!isQemu && !isLxc) return fail("Could not tell VM vs container from the archive name.");
        const params: Record<string, string | number> = { vmid };
        if (storage) params.storage = storage;
        if (force) params.force = 1;
        if (isQemu) {
          params.archive = volid;
          await proxmox.post(`/nodes/${n}/qemu`, params);
        } else {
          params.ostemplate = volid;
          params.restore = 1;
          await proxmox.post(`/nodes/${n}/lxc`, params);
        }
        return ok(`Restore of ${volName(volid)} → VMID ${vmid} on node ${n} requested.`);
      }),
  );
}
