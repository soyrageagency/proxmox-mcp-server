/**
 * Guest (VM / LXC) insight.
 *
 *   • list_guests  — all QEMU VMs and LXC containers across the cluster.
 *   • guest_status — live status of one guest (running/stopped, CPU/mem, uptime).
 *   • guest_config — full configuration of one guest.
 *
 * Guests are addressed by their numeric VMID (or name).
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { z } from "zod";
import type { ToolContext } from "./context.js";
import { asJsonBlock, formatBytes, formatPercent, formatUptime, renderTable, truncate } from "../utils/format.js";
import { guard, ok } from "../utils/result.js";

export function registerGuestTools({ server, proxmox }: ToolContext): void {
  server.registerTool(
    "list_guests",
    {
      title: "List VMs & containers",
      description:
        "List all QEMU virtual machines and LXC containers across the cluster " +
        "with their VMID, type, node, status and live CPU/memory. Optionally " +
        "filter by kind ('qemu' or 'lxc') or only running guests.",
      inputSchema: {
        kind: z.enum(["qemu", "lxc"]).optional().describe("Only VMs ('qemu') or only containers ('lxc')."),
        runningOnly: z.boolean().optional().describe("Only running guests (default: false)."),
      },
    },
    async ({ kind, runningOnly }) =>
      guard(async () => {
        let guests = await proxmox.guests();
        if (kind) guests = guests.filter((g) => g.type === kind);
        if (runningOnly) guests = guests.filter((g) => g.status === "running");
        guests.sort((a, b) => a.vmid - b.vmid);

        const rows = guests.map((g) => [
          String(g.vmid),
          g.type === "qemu" ? "VM" : "CT",
          truncate(g.name, 22),
          g.node,
          g.template ? "template" : g.status,
          g.status === "running" ? formatPercent(g.cpu) : "—",
          g.status === "running" ? `${formatBytes(g.mem)}/${formatBytes(g.maxmem)}` : "—",
          g.status === "running" ? formatUptime(g.uptime) : "—",
        ]);
        const table = renderTable(
          ["VMID", "KIND", "NAME", "NODE", "STATUS", "CPU", "MEMORY", "UPTIME"],
          rows,
        );
        return ok(`${guests.length} guest(s).\n\n${table}`);
      }),
  );

  server.registerTool(
    "guest_status",
    {
      title: "Guest status",
      description:
        "Live runtime status of a single VM or container: run state, CPU %, " +
        "memory, disk, uptime and (for VMs) QEMU guest-agent availability.",
      inputSchema: {
        guest: z.string().min(1).describe("VMID or name of the VM/container."),
      },
    },
    async ({ guest }) =>
      guard(async () => {
        const resolved = await proxmox.resolveGuest(guest);
        const status = await proxmox.guestStatus(resolved);
        const header = [
          `Name:   ${resolved.name} (VMID ${resolved.vmid}, ${resolved.type === "qemu" ? "VM" : "container"})`,
          `Node:   ${resolved.node}`,
          `Status: ${status.status ?? resolved.status}`,
          `Uptime: ${formatUptime(Number(status.uptime ?? 0))}`,
        ].join("\n");
        return ok(`${header}\n\n${asJsonBlock(status)}`);
      }),
  );

  server.registerTool(
    "guest_config",
    {
      title: "Guest config",
      description:
        "Return the full configuration of a VM or container (cores, memory, " +
        "disks, network interfaces, boot order, …).",
      inputSchema: {
        guest: z.string().min(1).describe("VMID or name of the VM/container."),
      },
    },
    async ({ guest }) =>
      guard(async () => {
        const resolved = await proxmox.resolveGuest(guest);
        const config = await proxmox.guestConfig(resolved);
        return ok(`Config of ${resolved.name} (VMID ${resolved.vmid}):\n\n${asJsonBlock(config)}`);
      }),
  );

  server.registerTool(
    "guest_osinfo",
    {
      title: "Guest OS info",
      description:
        "What operating system does a guest run? Returns the configured OS " +
        "type and, for running QEMU VMs with the guest agent, the detected OS " +
        "name/version and IP addresses. Answers 'what OS is VMID 101?'.",
      inputSchema: {
        guest: z.string().min(1).describe("VMID or name of the VM/container."),
      },
    },
    async ({ guest }) =>
      guard(async () => {
        const resolved = await proxmox.resolveGuest(guest);
        const info = await proxmox.osInfo(resolved);
        const agent = (info.agent as { result?: Record<string, unknown> } | undefined)?.result;
        const pretty = agent?.["pretty-name"] ?? agent?.name;
        const header = pretty
          ? `${resolved.name} (VMID ${resolved.vmid}) runs: ${String(pretty)}`
          : `${resolved.name} (VMID ${resolved.vmid}) — OS type: ${String(info.ostype)}`;
        return ok(`${header}\n\n${asJsonBlock(info)}`);
      }),
  );
}
