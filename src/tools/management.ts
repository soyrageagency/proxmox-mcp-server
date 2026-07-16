/**
 * Advanced guest management (state-changing).
 *
 *   • migrate_guest        — move a VM/CT to another node (online if running).
 *   • clone_guest          — clone a VM/CT (from a template or a live guest).
 *   • set_guest_resources  — quickly change CPU cores and/or memory.
 *   • backup_guest         — create a vzdump backup to a storage.
 *   • delete_guest         — permanently destroy a guest (guarded).
 *
 * The whole group is skipped in read-only mode.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { z } from "zod";
import type { ToolContext } from "./context.js";
import { guard, ok, fail } from "../utils/result.js";

export function registerManagementTools(ctx: ToolContext): void {
  const { server, proxmox, config, logger } = ctx;

  if (config.readOnly) {
    logger.info("Read-only mode: migrate/clone/resize/backup/delete are disabled.");
    return;
  }

  server.registerTool(
    "migrate_guest",
    {
      title: "Migrate guest",
      description:
        "Migrate a VM or container to another cluster node. Running guests are " +
        "migrated online (live) when possible.",
      inputSchema: {
        guest: z.string().min(1).describe("VMID or name."),
        target: z.string().min(1).describe("Target node name."),
        online: z.boolean().optional().describe("Force online/offline (default: online if running)."),
      },
    },
    async ({ guest, target, online }) =>
      guard(async () => {
        const g = await proxmox.resolveGuest(guest);
        if (g.node === target) return ok(`${g.name} (VMID ${g.vmid}) is already on node ${target}.`);
        const params: Record<string, string | number> = { target };
        const wantOnline = online ?? g.status === "running";
        if (g.type === "qemu" && wantOnline) params.online = 1;
        if (g.type === "lxc" && wantOnline) params.restart = 1; // LXC: online migration = restart
        await proxmox.post(`${proxmox.guestBase(g)}/migrate`, params);
        return ok(`Migration of ${g.name} (VMID ${g.vmid}) from ${g.node} → ${target} requested.`);
      }),
  );

  server.registerTool(
    "clone_guest",
    {
      title: "Clone guest",
      description:
        "Clone a VM or container into a new one. Great for deploying from a " +
        "template. `full` makes an independent full clone (vs. a linked clone).",
      inputSchema: {
        guest: z.string().min(1).describe("Source VMID or name (often a template)."),
        newid: z.number().int().positive().describe("VMID for the new guest (must be free)."),
        name: z.string().optional().describe("Name/hostname for the clone."),
        full: z.boolean().optional().describe("Full clone (independent copy)."),
        target: z.string().optional().describe("Target node for the clone."),
      },
    },
    async ({ guest, newid, name, full, target }) =>
      guard(async () => {
        const g = await proxmox.resolveGuest(guest);
        const params: Record<string, string | number> = { newid };
        if (name) params[g.type === "qemu" ? "name" : "hostname"] = name;
        if (full) params.full = 1;
        if (target) params.target = target;
        await proxmox.post(`${proxmox.guestBase(g)}/clone`, params);
        return ok(`Clone of ${g.name} (VMID ${g.vmid}) → VMID ${newid} requested.`);
      }),
  );

  server.registerTool(
    "set_guest_resources",
    {
      title: "Set guest resources",
      description:
        "Quickly change a guest's CPU cores and/or memory. For VMs, memory is " +
        "in MB. Some changes need a reboot to take effect.",
      inputSchema: {
        guest: z.string().min(1).describe("VMID or name."),
        cores: z.number().int().positive().max(256).optional().describe("Number of CPU cores."),
        memory: z.number().int().positive().optional().describe("Memory in MB."),
      },
    },
    async ({ guest, cores, memory }) =>
      guard(async () => {
        if (cores === undefined && memory === undefined) {
          return fail("Provide at least `cores` or `memory`.");
        }
        const g = await proxmox.resolveGuest(guest);
        const params: Record<string, string | number> = {};
        if (cores !== undefined) params.cores = cores;
        if (memory !== undefined) params.memory = memory;
        await proxmox.post(`${proxmox.guestBase(g)}/config`, params);
        const parts = [cores !== undefined ? `${cores} cores` : "", memory !== undefined ? `${memory} MB RAM` : ""].filter(Boolean);
        return ok(`Set ${parts.join(", ")} on ${g.name} (VMID ${g.vmid}).`);
      }),
  );

  server.registerTool(
    "backup_guest",
    {
      title: "Backup guest (vzdump)",
      description:
        "Create a backup of a VM or container to a storage using vzdump. " +
        "`mode` snapshot (default, no downtime), suspend, or stop.",
      inputSchema: {
        guest: z.string().min(1).describe("VMID or name."),
        storage: z.string().min(1).describe("Target storage id (must allow 'backup')."),
        mode: z.enum(["snapshot", "suspend", "stop"]).optional().describe("Backup mode (default: snapshot)."),
        compress: z.enum(["zstd", "gzip", "lzo", "0"]).optional().describe("Compression (default: zstd)."),
      },
    },
    async ({ guest, storage, mode, compress }) =>
      guard(async () => {
        const g = await proxmox.resolveGuest(guest);
        const params: Record<string, string | number> = {
          vmid: g.vmid,
          storage,
          mode: mode ?? "snapshot",
          compress: compress ?? "zstd",
        };
        await proxmox.post(`/nodes/${g.node}/vzdump`, params);
        return ok(`Backup of ${g.name} (VMID ${g.vmid}) to storage "${storage}" requested.`);
      }),
  );

  server.registerTool(
    "delete_guest",
    {
      title: "Delete guest",
      description:
        "PERMANENTLY destroy a VM or container and its disks. IRREVERSIBLE. " +
        "You must pass `confirm` equal to the guest's VMID to proceed.",
      inputSchema: {
        guest: z.string().min(1).describe("VMID or name."),
        confirm: z.string().min(1).describe("Must equal the guest's VMID to confirm."),
        purge: z.boolean().optional().describe("Also remove from backup jobs / HA (default: true)."),
      },
    },
    async ({ guest, confirm, purge }) =>
      guard(async () => {
        const g = await proxmox.resolveGuest(guest);
        if (confirm !== String(g.vmid)) {
          return fail(`Refusing to delete: pass confirm="${g.vmid}" to destroy ${g.name}.`);
        }
        if (g.status === "running") {
          return fail(`Stop ${g.name} (VMID ${g.vmid}) before deleting it.`);
        }
        const q = purge === false ? "" : "?purge=1&destroy-unreferenced-disks=1";
        await proxmox.del(`${proxmox.guestBase(g)}${q}`);
        return ok(`Deletion of ${g.name} (VMID ${g.vmid}) requested.`);
      }),
  );
}
