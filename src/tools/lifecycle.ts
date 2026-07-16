/**
 * Guest lifecycle tools (state-changing).
 *
 *   • start_guest    — power on a VM/container.
 *   • shutdown_guest — graceful ACPI shutdown (asks the guest OS).
 *   • stop_guest     — hard stop (pulls the virtual power cord).
 *   • reboot_guest   — graceful reboot.
 *
 * The whole group is skipped when the server runs in read-only mode.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { z } from "zod";
import type { ToolContext } from "./context.js";
import { guard, ok } from "../utils/result.js";

export function registerLifecycleTools(ctx: ToolContext): void {
  const { server, proxmox, config, logger } = ctx;

  if (config.readOnly) {
    logger.info("Read-only mode: guest lifecycle tools are disabled.");
    return;
  }

  const guestArg = { guest: z.string().min(1).describe("VMID or name of the VM/container.") };

  server.registerTool(
    "start_guest",
    {
      title: "Start guest",
      description: "Power on a VM or container. No-op if it is already running.",
      inputSchema: guestArg,
    },
    async ({ guest }) =>
      guard(async () => {
        const g = await proxmox.resolveGuest(guest);
        if (g.status === "running") return ok(`${g.name} (VMID ${g.vmid}) is already running.`);
        await proxmox.post(`${proxmox.guestBase(g)}/status/start`);
        return ok(`Start requested for ${g.name} (VMID ${g.vmid}) on node ${g.node}.`);
      }),
  );

  server.registerTool(
    "shutdown_guest",
    {
      title: "Shutdown guest (graceful)",
      description:
        "Gracefully shut down a VM or container via ACPI/guest OS. This is the " +
        "safe way to power off — prefer it over `stop_guest`.",
      inputSchema: {
        ...guestArg,
        timeout: z.number().int().positive().max(3600).optional().describe("Seconds to wait before giving up."),
      },
    },
    async ({ guest, timeout }) =>
      guard(async () => {
        const g = await proxmox.resolveGuest(guest);
        if (g.status !== "running") return ok(`${g.name} (VMID ${g.vmid}) is not running.`);
        const params = timeout ? { timeout } : undefined;
        await proxmox.post(`${proxmox.guestBase(g)}/status/shutdown`, params);
        return ok(`Graceful shutdown requested for ${g.name} (VMID ${g.vmid}).`);
      }),
  );

  server.registerTool(
    "stop_guest",
    {
      title: "Stop guest (hard)",
      description:
        "Immediately stop a VM or container — equivalent to pulling the power " +
        "cord. May cause data loss; prefer `shutdown_guest`. Confirm first.",
      inputSchema: guestArg,
    },
    async ({ guest }) =>
      guard(async () => {
        const g = await proxmox.resolveGuest(guest);
        await proxmox.post(`${proxmox.guestBase(g)}/status/stop`);
        return ok(`Hard stop requested for ${g.name} (VMID ${g.vmid}).`);
      }),
  );

  server.registerTool(
    "reboot_guest",
    {
      title: "Reboot guest",
      description: "Gracefully reboot a running VM or container.",
      inputSchema: guestArg,
    },
    async ({ guest }) =>
      guard(async () => {
        const g = await proxmox.resolveGuest(guest);
        await proxmox.post(`${proxmox.guestBase(g)}/status/reboot`);
        return ok(`Reboot requested for ${g.name} (VMID ${g.vmid}).`);
      }),
  );

  server.registerTool(
    "suspend_guest",
    {
      title: "Suspend guest",
      description:
        "Suspend (pause) a running VM — freezes it in RAM so it can be resumed " +
        "instantly. Set `toDisk` to hibernate to disk instead.",
      inputSchema: {
        ...guestArg,
        toDisk: z.boolean().optional().describe("Hibernate to disk (QEMU) instead of pausing in RAM."),
      },
    },
    async ({ guest, toDisk }) =>
      guard(async () => {
        const g = await proxmox.resolveGuest(guest);
        await proxmox.post(`${proxmox.guestBase(g)}/status/suspend`, toDisk ? { todisk: 1 } : undefined);
        return ok(`Suspend requested for ${g.name} (VMID ${g.vmid}).`);
      }),
  );

  server.registerTool(
    "resume_guest",
    {
      title: "Resume guest",
      description: "Resume a suspended/paused VM.",
      inputSchema: guestArg,
    },
    async ({ guest }) =>
      guard(async () => {
        const g = await proxmox.resolveGuest(guest);
        await proxmox.post(`${proxmox.guestBase(g)}/status/resume`);
        return ok(`Resume requested for ${g.name} (VMID ${g.vmid}).`);
      }),
  );
}
