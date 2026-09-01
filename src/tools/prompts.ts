/**
 * MCP prompts & resources.
 *
 * Tools answer a question the user already knew how to ask. Prompts are the
 * other half: the client lists them, so the user discovers "audit my cluster"
 * without having to know that `cluster_health`, `find_orphaned_disks` and
 * `list_backups` exist or what order to call them in.
 *
 * Resources expose the cluster as readable context — a client can attach
 * `proxmox://cluster/overview` to a conversation instead of the model spending
 * three tool calls rebuilding the same picture.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * MIT licensed (see LICENSE).
 */

import { z } from "zod";
import type { ToolContext } from "./context.js";
import { formatBytes, formatPercent, formatUptime, renderTable } from "../utils/format.js";

/** Wrap prompt text in the message envelope the MCP SDK expects. */
function userPrompt(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerPrompts(ctx: ToolContext): void {
  const { server, proxmox, config } = ctx;

  // ── Prompts ──────────────────────────────────────────────────────────────

  server.registerPrompt(
    "audit-cluster",
    {
      title: "Audit the cluster",
      description:
        "Full read-only sweep: health, wasted space, idle guests and backup " +
        "coverage, ending in a short prioritised list of what to do.",
      argsSchema: {
        focus: z
          .enum(["everything", "capacity", "reliability", "waste"])
          .optional()
          .describe("Narrow the audit. Defaults to everything."),
      },
    },
    ({ focus }) => {
      const area = focus ?? "everything";
      const steps: Record<string, string[]> = {
        capacity: [
          "1. `cluster_health` — read the storage and node-pressure findings.",
          "2. `list_storage` — where the space actually went.",
          "3. `find_orphaned_disks` — space that belongs to nothing.",
          "4. `find_idle_guests` — RAM held by guests doing nothing.",
        ],
        reliability: [
          "1. `cluster_health` — quorum, node state, guests that are down.",
          "2. `list_backups` — is every guest actually covered, and how fresh?",
          "3. `list_tasks` — any failed jobs in the recent history?",
          "4. `list_snapshots` on anything important, to see if there is a rollback point.",
        ],
        waste: [
          "1. `find_orphaned_disks` — disks whose VM is gone.",
          "2. `find_idle_guests` — long uptime, no CPU.",
          "3. `list_storage` — which store is under pressure.",
        ],
        everything: [
          "1. `cluster_health` — the overall picture first.",
          "2. `list_nodes` and `list_guests` — what is actually deployed.",
          "3. `find_idle_guests` and `find_orphaned_disks` — reclaimable waste.",
          "4. `list_backups` — coverage and freshness.",
          "5. `list_tasks` — recent failures.",
        ],
      };

      return userPrompt(
        `Audit my Proxmox cluster, focusing on ${area}.\n\n` +
          `${steps[area].join("\n")}\n\n` +
          "Then give me:\n" +
          "- A one-line verdict.\n" +
          "- What needs attention now, worst first, each with the fix.\n" +
          "- What can wait.\n\n" +
          "Only mention findings you actually observed in the tool output — do not " +
          "pad the list. If nothing is wrong, say so plainly. Do not change anything: " +
          "this is a read-only audit, so propose actions and let me decide.",
      );
    },
  );

  server.registerPrompt(
    "plan-maintenance",
    {
      title: "Plan a maintenance window",
      description:
        "Work out the safe order to reboot or patch guests, what to snapshot " +
        "first, and what will break while each one is down.",
      argsSchema: {
        target: z
          .string()
          .optional()
          .describe("A node, or a VMID/name. Defaults to the whole cluster."),
      },
    },
    ({ target }) =>
      userPrompt(
        `Plan a maintenance window for ${target ? `\`${target}\`` : "my whole Proxmox cluster"}.\n\n` +
          "1. `cluster_health` and `list_guests` — establish what is running now.\n" +
          "2. For each guest in scope, `get_guest_config` — note what it does and " +
          "what depends on it (reverse proxies, databases, DNS).\n" +
          "3. `list_snapshots` — see what rollback points already exist.\n\n" +
          "Then give me a plan with:\n" +
          "- The order to take things down, dependencies last to go and first to " +
          "come back.\n" +
          "- Which guests I should snapshot before touching, and which are not worth it.\n" +
          "- What will be unreachable during each step, in plain terms " +
          "(\"your Home Assistant will be offline for ~2 minutes\").\n" +
          "- The rollback move if a step goes wrong.\n\n" +
          "Do not execute anything. If a guest looks risky to restart — a database " +
          "with no recent backup, say — flag it rather than sequencing around it quietly.",
      ),
  );

  server.registerPrompt(
    "explain-guest",
    {
      title: "Explain a guest",
      description:
        "Everything about one VM or container in plain language: what it is, " +
        "how it is configured, how it is doing and whether it is protected.",
      argsSchema: {
        guest: z.string().describe("VMID or name, e.g. 101 or \"db\"."),
      },
    },
    ({ guest }) =>
      userPrompt(
        `Tell me everything about Proxmox guest \`${guest}\`.\n\n` +
          "Use `get_guest_status`, `get_guest_config`, `guest_osinfo`, " +
          "`list_snapshots` and `list_backups`.\n\n" +
          "Explain in plain language:\n" +
          "- What this thing is and, as far as you can tell, what it is for.\n" +
          "- How it is configured: cores, memory, disks, network.\n" +
          "- How it is actually doing: is it under pressure, or oversized for the job?\n" +
          "- Whether it is protected: recent snapshot, recent backup, or neither.\n\n" +
          "Finish with anything that looks wrong or wasteful. If it is all fine, say so.",
      ),
  );

  server.registerPrompt(
    "free-up-space",
    {
      title: "Free up space",
      description:
        "Find reclaimable space on the cluster and rank it by how much it " +
        "returns against how risky it is to remove.",
      argsSchema: {},
    },
    () =>
      userPrompt(
        "I am running low on space in Proxmox. Find what I can reclaim.\n\n" +
          "1. `list_storage` — which store is tight.\n" +
          "2. `find_orphaned_disks` — disks whose owner no longer exists.\n" +
          "3. `list_backups` — old backups beyond my retention.\n" +
          "4. `find_idle_guests` — guests I might not need running at all.\n\n" +
          "Rank what you find by (space returned ÷ risk). For each item give me " +
          "the exact command to run and say what I lose by running it. Put anything " +
          "irreversible in its own section, clearly marked. Do not delete anything.",
      ),
  );

  // ── Resources ────────────────────────────────────────────────────────────

  server.registerResource(
    "cluster-overview",
    "proxmox://cluster/overview",
    {
      title: "Cluster overview",
      description:
        "Nodes, guests and storage in one snapshot. Attach this instead of " +
        "making the model rebuild the same picture from three tool calls.",
      mimeType: "text/plain",
    },
    async (uri) => {
      const [nodes, guests] = await Promise.all([proxmox.nodes(), proxmox.guests()]);
      const probe = nodes.find((n) => n.status === "online")?.node;
      const stores = probe ? await proxmox.storage(probe).catch(() => []) : [];

      const nodeTable = renderTable(
        ["NODE", "STATUS", "CPU", "MEMORY", "UPTIME"],
        nodes.map((n) => [
          n.node,
          n.status,
          formatPercent(n.cpu),
          `${formatBytes(n.mem)}/${formatBytes(n.maxmem)}`,
          formatUptime(n.uptime),
        ]),
      );
      const guestTable = renderTable(
        ["VMID", "KIND", "NAME", "NODE", "STATUS", "MEMORY"],
        guests.map((g) => [
          String(g.vmid),
          g.type === "qemu" ? "VM" : "CT",
          g.name,
          g.node,
          g.status,
          `${formatBytes(g.mem)}/${formatBytes(g.maxmem)}`,
        ]),
      );
      const storeTable = renderTable(
        ["STORAGE", "TYPE", "USED", "TOTAL", "FULL"],
        stores.map((s) => {
          const total = Number(s.total ?? 0);
          const used = Number(s.used ?? 0);
          return [
            String(s.storage ?? ""),
            String(s.type ?? ""),
            formatBytes(used),
            formatBytes(total),
            total ? formatPercent(used / total) : "—",
          ];
        }),
      );

      const text = [
        `Proxmox cluster overview — generated ${new Date().toISOString()}`,
        config.demo ? "(DEMO MODE: this is fabricated data, not a real cluster.)" : "",
        "",
        `NODES (${nodes.length})`,
        nodeTable,
        "",
        `GUESTS (${guests.length})`,
        guestTable,
        "",
        `STORAGE (${stores.length})`,
        storeTable,
      ]
        .filter(Boolean)
        .join("\n");

      return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
    },
  );

  server.registerResource(
    "capabilities",
    "proxmox://server/capabilities",
    {
      title: "Server capabilities",
      description:
        "Which plugins are loaded, whether the server is read-only, and what " +
        "the allowlist permits. Read this before assuming a tool exists.",
      mimeType: "text/plain",
    },
    async (uri) => {
      const text = [
        `Proxmox MCP Server — mode: ${config.readOnly ? "READ-ONLY" : "read/write"}`,
        config.demo ? "Demo mode: serving fabricated data." : `Host: ${config.host || "(not configured)"}`,
        config.allowlist.length
          ? `Allowlist: only ${config.allowlist.join(", ")} are reachable.`
          : "Allowlist: empty — every guest is reachable.",
        "",
        renderTable(
          ["PLUGIN", "ENABLED", "MUTATING", "TITLE"],
          ctx.plugins.map((p) => [p.name, p.enabled ? "yes" : "no", p.mutating ? "yes" : "no", p.title]),
        ),
      ].join("\n");
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
    },
  );
}
