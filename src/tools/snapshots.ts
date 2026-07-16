/**
 * Snapshot tools.
 *
 * Read-only:
 *   • list_snapshots — snapshots of a guest (with the special "current" state).
 *
 * State-changing (skipped in read-only mode):
 *   • create_snapshot   — take a snapshot (optionally with RAM).
 *   • rollback_snapshot — revert a guest to a snapshot (destructive).
 *   • delete_snapshot   — remove a snapshot.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { z } from "zod";
import type { ToolContext } from "./context.js";
import { renderTable, truncate } from "../utils/format.js";
import { guard, ok } from "../utils/result.js";

export function registerSnapshotTools(ctx: ToolContext): void {
  const { server, proxmox, config, logger } = ctx;

  server.registerTool(
    "list_snapshots",
    {
      title: "List snapshots",
      description:
        "List the snapshots of a VM or container, including their name, parent " +
        "and description. The synthetic 'current' entry marks the live state.",
      inputSchema: {
        guest: z.string().min(1).describe("VMID or name of the VM/container."),
      },
    },
    async ({ guest }) =>
      guard(async () => {
        const resolved = await proxmox.resolveGuest(guest);
        const snaps = await proxmox.snapshots(resolved);
        const rows = (snaps ?? []).map((s) => [
          truncate(String(s.name ?? ""), 24),
          truncate(String(s.parent ?? "—"), 20),
          truncate(String(s.description ?? "").replace(/\n/g, " "), 40) || "—",
        ]);
        const table = renderTable(["SNAPSHOT", "PARENT", "DESCRIPTION"], rows);
        return ok(`Snapshots of ${resolved.name} (VMID ${resolved.vmid}):\n\n${table}`);
      }),
  );

  if (config.readOnly) {
    logger.info("Read-only mode: snapshot create/rollback/delete are disabled.");
    return;
  }

  server.registerTool(
    "create_snapshot",
    {
      title: "Create snapshot",
      description:
        "Take a snapshot of a VM or container. Optionally include the VM's RAM " +
        "(`vmstate`) so it can be resumed exactly.",
      inputSchema: {
        guest: z.string().min(1).describe("VMID or name."),
        name: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/).describe("Snapshot name (letters/digits/_/-)."),
        description: z.string().optional().describe("Optional description."),
        withRam: z.boolean().optional().describe("Include VM RAM state (QEMU only)."),
      },
    },
    async ({ guest, name, description, withRam }) =>
      guard(async () => {
        const resolved = await proxmox.resolveGuest(guest);
        const params: Record<string, string | number> = { snapname: name };
        if (description) params.description = description;
        if (withRam && resolved.type === "qemu") params.vmstate = 1;
        await proxmox.post(`${proxmox.guestBase(resolved)}/snapshot`, params);
        return ok(`Snapshot "${name}" requested for ${resolved.name} (VMID ${resolved.vmid}).`);
      }),
  );

  server.registerTool(
    "rollback_snapshot",
    {
      title: "Rollback snapshot",
      description:
        "Revert a VM or container to a snapshot. This is DESTRUCTIVE — any " +
        "changes made since the snapshot are lost. Confirm with the user first.",
      inputSchema: {
        guest: z.string().min(1).describe("VMID or name."),
        name: z.string().min(1).describe("Snapshot to roll back to."),
      },
    },
    async ({ guest, name }) =>
      guard(async () => {
        const resolved = await proxmox.resolveGuest(guest);
        await proxmox.post(`${proxmox.guestBase(resolved)}/snapshot/${encodeURIComponent(name)}/rollback`);
        return ok(`Rollback to "${name}" requested for ${resolved.name} (VMID ${resolved.vmid}).`);
      }),
  );

  server.registerTool(
    "delete_snapshot",
    {
      title: "Delete snapshot",
      description: "Remove a snapshot from a VM or container.",
      inputSchema: {
        guest: z.string().min(1).describe("VMID or name."),
        name: z.string().min(1).describe("Snapshot to delete."),
      },
    },
    async ({ guest, name }) =>
      guard(async () => {
        const resolved = await proxmox.resolveGuest(guest);
        await proxmox.del(`${proxmox.guestBase(resolved)}/snapshot/${encodeURIComponent(name)}`);
        return ok(`Snapshot "${name}" deletion requested for ${resolved.name} (VMID ${resolved.vmid}).`);
      }),
  );
}
