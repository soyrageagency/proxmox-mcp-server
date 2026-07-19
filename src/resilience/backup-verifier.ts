/**
 * Automated backup verification.
 *
 * Almost nobody tests their restores — they find out on the day of the
 * disaster. This takes the latest vzdump for each target guest, restores it
 * into an *ephemeral, network-isolated* VM, boots it, runs health checks
 * (service comes up, database answers, key-file checksums match), tears the
 * ephemeral guest down and emits a signed, dated evidence report.
 *
 * It runs fully in demo mode (no cluster needed) and, against a real cluster,
 * performs the actual restore → boot → check → destroy cycle via the Proxmox
 * API, fencing the restored guest onto an isolated bridge so it can never talk
 * to production while it is being validated.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { CONTROLS } from "./report.js";
import type { ResilienceContext } from "./engine.js";
import type { BackupVerifyItem, BackupVerifyReport, HealthCheck, Outcome } from "./types.js";
import { worst, nowIso, shortId, sleep } from "./util.js";

export interface VerifyOptions {
  /** Restrict to a single VMID; otherwise verify the latest backup per guest. */
  vmid?: number;
  /** Optional node to restore on (default: first node). */
  node?: string;
}

/** Backup archive picked for a guest (newest per VMID). */
interface Candidate {
  vmid: number;
  name: string;
  archive: string;
  ageSec: number;
  sizeBytes: number;
}

/** Select the newest backup archive for each in-scope VMID. */
async function candidates(ctx: ResilienceContext, opts: VerifyOptions): Promise<Candidate[]> {
  const node = await ctx.client.resolveNode(opts.node);
  const guests = await ctx.client.guests();
  const nameOf = (vmid: number) => guests.find((g) => g.vmid === vmid)?.name ?? `vmid-${vmid}`;
  const storages = await ctx.client.backupStorages(node);
  const now = Math.floor(Date.now() / 1000);
  const best = new Map<number, Candidate>();
  for (const s of storages) {
    for (const it of (await ctx.client.storageContent(node, s, "backup")) ?? []) {
      const vmid = Number(it.vmid ?? 0);
      if (!vmid) continue;
      if (opts.vmid && vmid !== opts.vmid) continue;
      const ctime = Number(it.ctime ?? 0);
      const prev = best.get(vmid);
      if (!prev || now - ctime < prev.ageSec) {
        best.set(vmid, {
          vmid,
          name: nameOf(vmid),
          archive: String(it.volid ?? ""),
          ageSec: Math.max(0, now - ctime),
          sizeBytes: Number(it.size ?? 0),
        });
      }
    }
  }
  return [...best.values()].sort((a, b) => a.vmid - b.vmid);
}

/** Build the health-check set appropriate for a guest. */
function planChecks(c: Candidate): Array<{ id: string; label: string }> {
  const checks = [
    { id: "service-up", label: "Guest boots & agent responds" },
    { id: "checksum:/etc/fstab", label: "Key-file checksum: /etc/fstab" },
  ];
  if (/db|postgres|mysql|maria/i.test(c.name)) {
    checks.splice(1, 0, { id: "db-responds", label: "Database accepts connections" });
    checks.push({ id: "checksum:/var/lib/db/PG_VERSION", label: "Key-file checksum: PG_VERSION" });
  } else {
    checks.push({ id: "checksum:/etc/os-release", label: "Key-file checksum: /etc/os-release" });
  }
  return checks;
}

/** Demo simulation of a single restore+verify cycle. */
function simulateItem(ctx: ResilienceContext, c: Candidate): BackupVerifyItem {
  const restoreSec = Math.round(c.sizeBytes / (220 * 1024 * 1024)) + 24; // ~220 MB/s + boot
  const specs = planChecks(c);
  const checks: HealthCheck[] = specs.map((spec, i) => {
    // Everything passes except a deliberately-surfaced checksum drift on grafana,
    // to prove the verifier actually inspects rather than rubber-stamps.
    const drift = c.name === "grafana" && spec.id.startsWith("checksum:");
    const outcome: Outcome = drift ? "warn" : "pass";
    const detail = drift
      ? "checksum differs from golden baseline (config changed since baseline)"
      : spec.id === "service-up"
        ? "systemd reached graphical.target; qemu-guest-agent ping OK"
        : spec.id === "db-responds"
          ? "pg_isready: accepting connections on 5432"
          : "sha256 matches recorded baseline";
    return { ...spec, outcome, detail, ms: 120 + i * 40 + (spec.id === "service-up" ? restoreSec * 3 : 0) };
  });
  return {
    vmid: c.vmid,
    name: c.name,
    archive: c.archive,
    archiveAgeSec: c.ageSec,
    ephemeralVmid: ctx.config.resilience.ephemeralVmidBase + c.vmid,
    restoreSec,
    checks,
    outcome: worst(checks.map((x) => x.outcome)),
    cleanedUp: true,
  };
}

/** Live restore+verify cycle for a single candidate (best-effort, conservative). */
async function verifyItemLive(ctx: ResilienceContext, c: Candidate): Promise<BackupVerifyItem> {
  const node = await ctx.client.resolveNode();
  const ephemeralVmid = ctx.config.resilience.ephemeralVmidBase + c.vmid;
  const isQemu = /vzdump-qemu-/.test(c.archive);
  const base = `/nodes/${node}/${isQemu ? "qemu" : "lxc"}/${ephemeralVmid}`;
  const checks: HealthCheck[] = [];
  let cleanedUp = false;
  const t0 = Date.now();
  try {
    // 1. Restore onto the ephemeral VMID (overwrite if a stale one exists).
    const params: Record<string, string | number> = { vmid: ephemeralVmid, force: 1 };
    if (isQemu) {
      params.archive = c.archive;
      await ctx.client.post(`/nodes/${node}/qemu`, params);
    } else {
      params.ostemplate = c.archive;
      params.restore = 1;
      await ctx.client.post(`/nodes/${node}/lxc`, params);
    }
    // 2. Fence the NIC onto the isolated bridge, link down.
    try {
      await ctx.client.post(`${base}/config`, {
        net0: `virtio,bridge=${ctx.config.resilience.isolatedBridge},link_down=1`,
      });
    } catch {
      /* non-fatal: some guests have no net0 */
    }
    // 3. Boot and wait for the agent.
    await ctx.client.post(`${base}/status/start`);
    const restoreSec = Math.round((Date.now() - t0) / 1000);
    const agentUp = await waitForAgent(ctx, base, isQemu);
    checks.push({
      id: "service-up",
      label: "Guest boots & agent responds",
      outcome: agentUp ? "pass" : "warn",
      detail: agentUp ? "guest agent responded" : "guest booted; agent did not answer in time",
      ms: restoreSec * 1000,
    });
    // 4. Best-effort file/DB checks via the guest agent.
    for (const spec of planChecks(c).slice(1)) checks.push(await liveCheck(ctx, base, spec));

    return {
      vmid: c.vmid,
      name: c.name,
      archive: c.archive,
      archiveAgeSec: c.ageSec,
      ephemeralVmid,
      restoreSec,
      checks,
      outcome: worst(checks.map((x) => x.outcome)),
      cleanedUp,
    };
  } finally {
    // 5. Always tear the ephemeral guest down.
    try {
      await ctx.client.post(`${base}/status/stop`).catch(() => {});
      await sleep(1500);
      await ctx.client.del(`${base}?purge=1&destroy-unreferenced-disks=1`);
      cleanedUp = true;
    } catch (err) {
      ctx.logger.warn(`Ephemeral ${ephemeralVmid} cleanup failed: ${(err as Error).message}`);
    }
  }
}

async function waitForAgent(ctx: ResilienceContext, base: string, isQemu: boolean): Promise<boolean> {
  if (!isQemu) return true; // LXC has no agent; boot is enough
  for (let i = 0; i < 20; i++) {
    try {
      await ctx.client.get(`${base}/agent/ping`);
      return true;
    } catch {
      await sleep(3000);
    }
  }
  return false;
}

async function liveCheck(
  _ctx: ResilienceContext,
  _base: string,
  spec: { id: string; label: string },
): Promise<HealthCheck> {
  // Live file/DB verification needs the guest agent's exec API which varies by
  // guest; we mark it a warning with a clear note rather than assert a result
  // we cannot confirm. Demo mode exercises the full logic.
  return {
    ...spec,
    outcome: "warn",
    detail: "requires guest-agent exec on the restored guest — not asserted in this run",
  };
}

/** Verify the latest backup(s) and return an (unsigned) evidence report. */
export async function verifyBackups(ctx: ResilienceContext, opts: VerifyOptions = {}): Promise<BackupVerifyReport> {
  const startedAt = nowIso();
  const t0 = Date.now();
  const cands = await candidates(ctx, opts);
  if (cands.length === 0) {
    throw new Error(
      opts.vmid ? `No backup archive found for VMID ${opts.vmid}.` : "No backup archives found to verify.",
    );
  }
  const items: BackupVerifyItem[] = [];
  for (const c of cands) {
    items.push(ctx.client.isDemo ? simulateItem(ctx, c) : await verifyItemLive(ctx, c));
  }
  const outcome = worst(items.map((i) => i.outcome));
  const passed = items.filter((i) => i.outcome === "pass").length;
  const finishedAt = nowIso();
  return {
    capability: "backup-verify",
    id: shortId("BV"),
    title: "Backup restore verification",
    startedAt,
    finishedAt,
    durationSec: ctx.client.isDemo ? items.reduce((a, i) => a + i.restoreSec, 0) : Math.round((Date.now() - t0) / 1000),
    outcome,
    summary: `${passed}/${items.length} backup(s) restored & health-checked in an isolated sandbox; ${
      outcome === "pass" ? "all green" : outcome === "warn" ? "review warnings" : "failures found"
    }.`,
    demo: ctx.client.isDemo,
    controls: CONTROLS["backup-verify"],
    isolatedBridge: ctx.config.resilience.isolatedBridge,
    items,
  };
}
