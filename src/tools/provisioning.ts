/**
 * Provisioning tools — create new guests.
 *
 * Read-only:
 *   • list_templates — container templates (vztmpl) and ISO images available.
 *
 * State-changing (skipped in read-only mode):
 *   • create_container — create an LXC container from a template.
 *   • create_vm        — create a QEMU VM (with a disk and optional install ISO).
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { z } from "zod";
import type { ToolContext } from "./context.js";
import { formatBytes, renderTable, truncate } from "../utils/format.js";
import { guard, ok } from "../utils/result.js";

export function registerProvisioningTools(ctx: ToolContext): void {
  const { server, proxmox, config, logger } = ctx;

  server.registerTool(
    "list_templates",
    {
      title: "List templates & ISOs",
      description:
        "List the OS you can build from: LXC container templates (vztmpl) and " +
        "VM install images (ISO), across the node's storages. Use these volids " +
        "with create_container / create_vm.",
      inputSchema: {
        node: z.string().optional().describe("Node to query (default: first node)."),
      },
    },
    async ({ node }) =>
      guard(async () => {
        const n = await proxmox.resolveNode(node);
        const storages = await proxmox.storage(n);
        const rows: string[][] = [];
        for (const s of storages) {
          const content = String(s.content ?? "");
          const store = String(s.storage ?? "");
          for (const kind of ["vztmpl", "iso"] as const) {
            if (!content.includes(kind)) continue;
            const items = await proxmox.storageContent(n, store, kind);
            for (const it of items ?? []) {
              rows.push([
                kind === "vztmpl" ? "CT template" : "VM ISO",
                truncate(String(it.volid ?? ""), 52),
                formatBytes(Number(it.size ?? 0)),
              ]);
            }
          }
        }
        const table = renderTable(["KIND", "VOLID", "SIZE"], rows);
        return ok(`${rows.length} template(s)/ISO(s):\n\n${table}`);
      }),
  );

  if (config.readOnly) {
    logger.info("Read-only mode: create_container / create_vm are disabled.");
    return;
  }

  server.registerTool(
    "create_container",
    {
      title: "Create LXC container",
      description:
        "Create a new LXC container from a template (see list_templates). " +
        "Rootfs is created on `storage` with the given disk size.",
      inputSchema: {
        vmid: z.number().int().positive().describe("VMID for the new container (must be free)."),
        ostemplate: z.string().min(1).describe("Template volid, e.g. 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst'."),
        storage: z.string().min(1).describe("Storage for the rootfs (e.g. 'local-lvm')."),
        hostname: z.string().optional().describe("Container hostname."),
        cores: z.number().int().positive().max(256).optional().describe("CPU cores (default: 1)."),
        memory: z.number().int().positive().optional().describe("Memory in MB (default: 512)."),
        diskGb: z.number().int().positive().optional().describe("Rootfs size in GB (default: 8)."),
        node: z.string().optional().describe("Node to create on (default: first node)."),
        unprivileged: z.boolean().optional().describe("Unprivileged container (default: true)."),
      },
    },
    async ({ vmid, ostemplate, storage, hostname, cores, memory, diskGb, node, unprivileged }) =>
      guard(async () => {
        const n = await proxmox.resolveNode(node);
        const params: Record<string, string | number> = {
          vmid,
          ostemplate,
          storage,
          cores: cores ?? 1,
          memory: memory ?? 512,
          rootfs: `${storage}:${diskGb ?? 8}`,
          unprivileged: unprivileged === false ? 0 : 1,
          net0: "name=eth0,bridge=vmbr0,ip=dhcp",
        };
        if (hostname) params.hostname = hostname;
        await proxmox.post(`/nodes/${n}/lxc`, params);
        return ok(`Container ${hostname ?? "ct" + vmid} (VMID ${vmid}) creation requested on node ${n}.`);
      }),
  );

  server.registerTool(
    "create_vm",
    {
      title: "Create QEMU VM",
      description:
        "Create a new QEMU VM with a disk and, optionally, an install ISO " +
        "mounted as a CD-ROM (see list_templates). Boots from disk then CD.",
      inputSchema: {
        vmid: z.number().int().positive().describe("VMID for the new VM (must be free)."),
        name: z.string().optional().describe("VM name."),
        storage: z.string().min(1).describe("Storage for the VM disk (e.g. 'local-lvm')."),
        diskGb: z.number().int().positive().optional().describe("Disk size in GB (default: 32)."),
        cores: z.number().int().positive().max(256).optional().describe("CPU cores (default: 2)."),
        memory: z.number().int().positive().optional().describe("Memory in MB (default: 2048)."),
        iso: z.string().optional().describe("ISO volid to mount, e.g. 'local:iso/debian-12.7.0-amd64-netinst.iso'."),
        ostype: z.string().optional().describe("OS type hint (e.g. 'l26', 'win11'). Default: l26."),
        node: z.string().optional().describe("Node to create on (default: first node)."),
      },
    },
    async ({ vmid, name, storage, diskGb, cores, memory, iso, ostype, node }) =>
      guard(async () => {
        const n = await proxmox.resolveNode(node);
        const params: Record<string, string | number> = {
          vmid,
          cores: cores ?? 2,
          memory: memory ?? 2048,
          ostype: ostype ?? "l26",
          scsihw: "virtio-scsi-single",
          scsi0: `${storage}:${diskGb ?? 32}`,
          net0: "virtio,bridge=vmbr0",
          boot: iso ? "order=scsi0;ide2" : "order=scsi0",
        };
        if (name) params.name = name;
        if (iso) params.ide2 = `${iso},media=cdrom`;
        await proxmox.post(`/nodes/${n}/qemu`, params);
        return ok(`VM ${name ?? "vm" + vmid} (VMID ${vmid}) creation requested on node ${n}${iso ? " with install ISO" : ""}.`);
      }),
  );
}
