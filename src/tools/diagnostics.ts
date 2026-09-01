/**
 * Cluster diagnostics — the questions you actually ask on a Saturday morning.
 *
 *   • cluster_health       — one scored report: quorum, node pressure, storage
 *                            headroom, guests that should be running, backup
 *                            freshness. Findings, not a data dump.
 *   • find_idle_guests     — guests that have been up for ages doing nothing,
 *                            i.e. the ones quietly eating RAM for no reason.
 *   • find_orphaned_disks  — disk images whose owning VM no longer exists.
 *                            These survive a VM deletion more often than
 *                            anyone expects and are pure wasted space.
 *
 * All three are read-only, so they stay available in read-only mode.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * MIT licensed (see LICENSE).
 */

import { z } from "zod";
import type { ToolContext } from "./context.js";
import { formatBytes, formatPercent, formatUptime, renderTable } from "../utils/format.js";
import { guard, ok } from "../utils/result.js";

/** Severity of a single health finding, worst first. */
type Severity = "critical" | "warning" | "ok";

interface Finding {
  readonly severity: Severity;
  readonly area: string;
  readonly detail: string;
}

const ICON: Record<Severity, string> = { critical: "✗", warning: "!", ok: "✓" };
const RANK: Record<Severity, number> = { critical: 0, warning: 1, ok: 2 };

/** Seconds in a day, for the "how stale is this" arithmetic. */
const DAY = 86_400;

/**
 * Pull the VMID out of a volume id.
 *
 * Proxmox reports one in the `vmid` field for most storages, but plain
 * directory storages often don't, so fall back to the naming convention
 * (`local-lvm:vm-101-disk-0`, `local:104/vm-104-disk-0.qcow2`).
 */
function volumeVmid(entry: Record<string, unknown>): number | undefined {
  const declared = Number(entry.vmid);
  if (Number.isFinite(declared) && declared > 0) return declared;
  const volid = String(entry.volid ?? "");
  const match = /(?:^|[:/])(?:vm|subvol|base)-(\d+)-|(?:^|[:/])(\d+)\//.exec(volid);
  const found = match?.[1] ?? match?.[2];
  return found ? Number(found) : undefined;
}

export function registerDiagnosticsTools({ server, proxmox }: ToolContext): void {
  server.registerTool(
    "cluster_health",
    {
      title: "Cluster health check",
      description:
        "Run a read-only health check over the whole cluster and report only " +
        "what needs attention: quorum, per-node CPU/memory pressure, storage " +
        "headroom, guests that are stopped, and how stale the newest backup is. " +
        "Use this to answer 'is anything wrong?' in one call.",
      inputSchema: {
        cpuWarnPercent: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Node CPU usage that counts as pressure. Default 85."),
        memWarnPercent: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Node memory usage that counts as pressure. Default 90."),
        storageWarnPercent: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Storage usage that counts as low headroom. Default 85."),
        backupMaxAgeDays: z
          .number()
          .min(1)
          .optional()
          .describe("Flag the cluster if the newest backup is older than this. Default 7."),
      },
    },
    async ({ cpuWarnPercent, memWarnPercent, storageWarnPercent, backupMaxAgeDays }) =>
      guard(async () => {
        const cpuLimit = (cpuWarnPercent ?? 85) / 100;
        const memLimit = (memWarnPercent ?? 90) / 100;
        const storageLimit = (storageWarnPercent ?? 85) / 100;
        const backupLimit = (backupMaxAgeDays ?? 7) * DAY;

        const findings: Finding[] = [];

        // — Quorum ————————————————————————————————————————————————
        const status = await proxmox.clusterStatus();
        const clusterEntry = status.find((e) => e.type === "cluster");
        if (clusterEntry) {
          const quorate = Number(clusterEntry.quorate) === 1;
          findings.push({
            severity: quorate ? "ok" : "critical",
            area: "quorum",
            detail: quorate
              ? `Cluster "${String(clusterEntry.name ?? "?")}" is quorate (${String(clusterEntry.nodes ?? "?")} nodes).`
              : `Cluster "${String(clusterEntry.name ?? "?")}" has LOST QUORUM. Guests cannot be started and HA will not act.`,
          });
        } else {
          findings.push({
            severity: "ok",
            area: "quorum",
            detail: "Standalone node — quorum does not apply.",
          });
        }

        // — Nodes ————————————————————————————————————————————————
        const nodes = await proxmox.nodes();
        for (const node of nodes) {
          if (node.status !== "online") {
            findings.push({
              severity: "critical",
              area: `node/${node.node}`,
              detail: `Node is ${node.status}. Its guests are unreachable.`,
            });
            continue;
          }
          if (node.cpu >= cpuLimit) {
            findings.push({
              severity: "warning",
              area: `node/${node.node}`,
              detail: `CPU at ${formatPercent(node.cpu)} of ${node.maxcpu} core(s).`,
            });
          }
          const memRatio = node.maxmem ? node.mem / node.maxmem : 0;
          if (memRatio >= memLimit) {
            findings.push({
              severity: "warning",
              area: `node/${node.node}`,
              detail: `Memory at ${formatPercent(memRatio)} (${formatBytes(node.mem)} of ${formatBytes(node.maxmem)}).`,
            });
          }
        }
        const offline = nodes.filter((n) => n.status !== "online").length;
        if (nodes.length && offline === 0) {
          findings.push({
            severity: "ok",
            area: "nodes",
            detail: `All ${nodes.length} node(s) online.`,
          });
        }

        // — Storage ———————————————————————————————————————————————
        // Ask one online node: storage definitions are cluster-wide.
        const probe = nodes.find((n) => n.status === "online")?.node;
        if (probe) {
          const stores = await proxmox.storage(probe);
          let tight = 0;
          for (const store of stores) {
            const total = Number(store.total ?? 0);
            const used = Number(store.used ?? 0);
            if (!total) continue;
            const ratio = used / total;
            if (Number(store.active ?? 1) === 0) {
              findings.push({
                severity: "critical",
                area: `storage/${String(store.storage)}`,
                detail: "Storage is inactive — backups and disk operations against it will fail.",
              });
              continue;
            }
            if (ratio >= storageLimit) {
              tight++;
              findings.push({
                severity: ratio >= 0.95 ? "critical" : "warning",
                area: `storage/${String(store.storage)}`,
                detail: `${formatPercent(ratio)} full (${formatBytes(used)} of ${formatBytes(total)}).`,
              });
            }
          }
          if (stores.length && tight === 0) {
            findings.push({
              severity: "ok",
              area: "storage",
              detail: `All ${stores.length} storage(s) below ${formatPercent(storageLimit)}.`,
            });
          }
        }

        // — Guests ————————————————————————————————————————————————
        const guests = await proxmox.guests();
        const real = guests.filter((g) => !g.template);
        const stopped = real.filter((g) => g.status !== "running");
        if (stopped.length) {
          findings.push({
            severity: "warning",
            area: "guests",
            detail:
              `${stopped.length} of ${real.length} guest(s) not running: ` +
              stopped.map((g) => `${g.vmid} ${g.name}`).join(", ") +
              ". Intentional, or did something fall over?",
          });
        } else if (real.length) {
          findings.push({
            severity: "ok",
            area: "guests",
            detail: `All ${real.length} guest(s) running.`,
          });
        }

        // — Backups ———————————————————————————————————————————————
        if (probe) {
          const backups = await proxmox.storageContent(probe, "", "backup").catch(() => []);
          const now = Math.floor(Date.now() / 1000);
          const newest = backups.reduce(
            (max, b) => Math.max(max, Number(b.ctime ?? 0)),
            0,
          );
          const covered = new Set(
            backups.map((b) => volumeVmid(b)).filter((v): v is number => v !== undefined),
          );
          if (!newest) {
            findings.push({
              severity: "warning",
              area: "backups",
              detail: "No backups found on any backup storage.",
            });
          } else {
            const age = now - newest;
            findings.push({
              severity: age > backupLimit ? "warning" : "ok",
              area: "backups",
              detail:
                age > backupLimit
                  ? `Newest backup is ${Math.floor(age / DAY)} day(s) old — older than the ${Math.floor(backupLimit / DAY)}-day threshold.`
                  : `Newest backup is ${formatUptime(age)} old.`,
            });
          }
          const unbacked = real.filter((g) => !covered.has(g.vmid));
          if (unbacked.length) {
            findings.push({
              severity: "warning",
              area: "backups",
              detail:
                `${unbacked.length} guest(s) have no backup at all: ` +
                unbacked.map((g) => `${g.vmid} ${g.name}`).join(", ") + ".",
            });
          }
        }

        findings.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
        const critical = findings.filter((f) => f.severity === "critical").length;
        const warnings = findings.filter((f) => f.severity === "warning").length;

        const verdict =
          critical > 0
            ? `NEEDS ATTENTION — ${critical} critical, ${warnings} warning(s).`
            : warnings > 0
              ? `MOSTLY HEALTHY — ${warnings} warning(s), nothing critical.`
              : "HEALTHY — nothing to report.";

        const table = renderTable(
          ["", "AREA", "DETAIL"],
          findings.map((f) => [ICON[f.severity], f.area, f.detail]),
        );
        return ok(`${verdict}\n\n${table}`);
      }),
  );

  server.registerTool(
    "find_idle_guests",
    {
      title: "Find idle guests",
      description:
        "List running guests that have been up a long time while using almost " +
        "no CPU — the ones quietly holding RAM for nothing. Reports the memory " +
        "that would be freed. Read-only: it suggests, it never stops anything.",
      inputSchema: {
        cpuBelowPercent: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Count a guest as idle below this CPU usage. Default 2."),
        upForAtLeastDays: z
          .number()
          .min(0)
          .optional()
          .describe("Ignore guests that booted recently. Default 3 days."),
      },
    },
    async ({ cpuBelowPercent, upForAtLeastDays }) =>
      guard(async () => {
        const cpuLimit = (cpuBelowPercent ?? 2) / 100;
        const minUptime = (upForAtLeastDays ?? 3) * DAY;

        const guests = await proxmox.guests();
        const idle = guests
          .filter(
            (g) =>
              !g.template &&
              g.status === "running" &&
              g.cpu <= cpuLimit &&
              g.uptime >= minUptime,
          )
          .sort((a, b) => b.mem - a.mem);

        if (!idle.length) {
          return ok(
            `No idle guests: nothing running below ${formatPercent(cpuLimit)} CPU ` +
              `that has been up for ${upForAtLeastDays ?? 3}+ day(s).`,
          );
        }

        const reclaimable = idle.reduce((sum, g) => sum + g.mem, 0);
        const table = renderTable(
          ["VMID", "KIND", "NAME", "NODE", "CPU", "MEMORY IN USE", "UP FOR"],
          idle.map((g) => [
            String(g.vmid),
            g.type === "qemu" ? "VM" : "CT",
            g.name,
            g.node,
            formatPercent(g.cpu),
            formatBytes(g.mem),
            formatUptime(g.uptime),
          ]),
        );
        return ok(
          `${idle.length} idle guest(s) — about ${formatBytes(reclaimable)} of RAM in use between them.\n\n` +
            `${table}\n\n` +
            "Low CPU alone does not mean unused: a file server or a DNS resolver is idle by design. " +
            "Check what each one does before shutting anything down.",
        );
      }),
  );

  server.registerTool(
    "find_orphaned_disks",
    {
      title: "Find orphaned disks",
      description:
        "Find disk images on storage whose owning VM or container no longer " +
        "exists. Deleting a guest does not always remove every volume, and the " +
        "leftovers are invisible in the UI. Read-only: it reports, it never " +
        "deletes. Reports how much space they take.",
      inputSchema: {
        node: z
          .string()
          .optional()
          .describe("Node whose storages to scan. Defaults to the first online node."),
      },
    },
    async ({ node }) =>
      guard(async () => {
        const target = await proxmox.resolveNode(node);
        const guests = await proxmox.guests();
        const live = new Set(guests.map((g) => g.vmid));

        const stores = await proxmox.storage(target);
        const imageStores = stores.filter((s) =>
          String(s.content ?? "").split(",").some((c) => c === "images" || c === "rootdir"),
        );

        const orphans: Array<{ volid: string; vmid: number; size: number; storage: string }> = [];
        for (const store of imageStores) {
          const name = String(store.storage);
          const items = await proxmox.storageContent(target, name, "images").catch(() => []);
          for (const item of items) {
            const vmid = volumeVmid(item);
            if (vmid === undefined || live.has(vmid)) continue;
            orphans.push({
              volid: String(item.volid ?? ""),
              vmid,
              size: Number(item.size ?? 0),
              storage: name,
            });
          }
        }

        if (!orphans.length) {
          return ok(
            `No orphaned disks on ${target}. Every image on ` +
              `${imageStores.length} storage(s) belongs to a guest that still exists.`,
          );
        }

        orphans.sort((a, b) => b.size - a.size);
        const wasted = orphans.reduce((sum, o) => sum + o.size, 0);
        const table = renderTable(
          ["VMID", "STORAGE", "SIZE", "VOLUME"],
          orphans.map((o) => [String(o.vmid), o.storage, formatBytes(o.size), o.volid]),
        );
        return ok(
          `${orphans.length} orphaned disk(s) on ${target}, wasting ${formatBytes(wasted)}.\n\n` +
            `${table}\n\n` +
            "Each belongs to a VMID with no guest. Confirm the guest is really gone " +
            "(it could live on another node, or be mid-migration), then remove with " +
            "`pvesm free <volume>` on the node.",
        );
      }),
  );
}
