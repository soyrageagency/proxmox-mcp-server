/**
 * Resilience & Compliance engine.
 *
 * The façade the MCP tools and the TUI talk to. It runs the three capabilities
 * (backup verification, patch orchestration, DR drills), signs each resulting
 * report with an Ed25519 key, writes JSON + Markdown + HTML evidence to disk,
 * and surfaces recent runs for dashboards.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { ProxmoxClient } from "../proxmox/client.js";
import { verifyBackups, type VerifyOptions } from "./backup-verifier.js";
import { orchestratePatching, type PatchOptions } from "./patch-orchestrator.js";
import { runDrill } from "./dr-drill.js";
import { parseRunbook, type Runbook } from "./runbook.js";
import { signPayload } from "./signing.js";
import { summarize, writeReports, type ReportPaths } from "./report.js";
import type { ResilienceReport, RunSummary } from "./types.js";
import { nowIso } from "./util.js";

/** Everything the capability builders need. */
export interface ResilienceContext {
  client: ProxmoxClient;
  config: AppConfig;
  logger: Logger;
}

/** A finished, signed run plus where its evidence was written. */
export interface RunResult {
  report: ResilienceReport;
  paths: ReportPaths;
}

/** Built-in runbook used for demo drills and as a starting template. */
export const DEMO_RUNBOOK: Runbook = {
  name: "Quarterly failover drill",
  environment: "staging",
  description: "Restore the core stack into the isolated staging env and validate recovery.",
  rpoHours: 24,
  steps: [
    { action: "notify", note: "DR drill starting — stakeholders informed" },
    { action: "restore", guest: "db", from: "latest" },
    { action: "start", guest: "db" },
    { action: "healthcheck", guest: "db", check: "db" },
    { action: "restore", guest: "web", from: "latest" },
    { action: "start", guest: "web" },
    { action: "healthcheck", guest: "web", check: "http" },
    { action: "verify-file", guest: "web", path: "/etc/nginx/nginx.conf" },
    { action: "failover", guest: "web" },
    { action: "teardown" },
  ],
};

export class ResilienceEngine {
  private samplesCache: ResilienceReport[] | null = null;

  constructor(private readonly ctx: ResilienceContext) {}

  private get keyPath(): string {
    return this.ctx.config.resilience.signingKey || join(this.ctx.config.resilience.dir, ".signing-ed25519.pem");
  }

  /** Sign, persist and return a finished report. */
  private finalize(report: ResilienceReport): RunResult {
    const { signature, ...payload } = report;
    void signature;
    report.signature = signPayload(payload, this.keyPath, nowIso());
    const paths = writeReports(report, this.ctx.config.resilience.dir);
    this.ctx.logger.info(`Resilience report ${report.id} written to ${paths.markdown}`);
    this.samplesCache = null; // invalidate dashboard cache
    return { report, paths };
  }

  /** Run the automated backup verifier. */
  async verifyBackups(opts: VerifyOptions = {}): Promise<RunResult> {
    return this.finalize(await verifyBackups(this.ctx, opts));
  }

  /** Run the patch orchestrator. */
  async orchestratePatching(opts: PatchOptions = {}): Promise<RunResult> {
    return this.finalize(await orchestratePatching(this.ctx, opts));
  }

  /** Run a DR drill from runbook text (YAML or JSON). */
  async runDrill(runbookText: string): Promise<RunResult> {
    return this.finalize(await runDrill(this.ctx, parseRunbook(runbookText)));
  }

  /** Run a DR drill from an already-parsed runbook. */
  async runDrillObject(runbook: Runbook): Promise<RunResult> {
    return this.finalize(await runDrill(this.ctx, runbook));
  }

  /** All reports on disk, newest first. */
  private diskReports(): ResilienceReport[] {
    const dir = this.ctx.config.resilience.dir;
    if (!existsSync(dir)) return [];
    const reports: ResilienceReport[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        reports.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as ResilienceReport);
      } catch {
        /* skip unreadable */
      }
    }
    return reports.sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
  }

  /**
   * Recent reports for the dashboard: real runs from disk. In DEMO mode only,
   * capabilities that have never been run are back-filled with fabricated
   * in-memory samples so the dashboard looks alive.
   *
   * Against a real cluster we return exactly what is on disk and NOTHING else:
   * the sample builders perform real work (restoring ephemeral VMs, snapshotting
   * guests), so they must never be triggered by a read-only listing.
   */
  async recentReports(): Promise<ResilienceReport[]> {
    const disk = this.diskReports();
    if (!this.ctx.client.isDemo) return disk;
    const have = new Set(disk.map((r) => r.capability));
    const need = (["backup-verify", "patch-orchestrate", "dr-drill"] as const).filter((c) => !have.has(c));
    if (need.length === 0) return disk;
    const samples = await this.demoSamples();
    const fill = samples.filter((s) => need.includes(s.capability as (typeof need)[number]));
    return [...disk, ...fill].sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
  }

  /** Compact summaries of the most recent run per capability. */
  async recentSummaries(): Promise<RunSummary[]> {
    const reports = await this.recentReports();
    const seen = new Set<string>();
    const out: RunSummary[] = [];
    for (const r of reports) {
      if (seen.has(r.capability)) continue;
      seen.add(r.capability);
      out.push(summarize(r));
    }
    const order = { "backup-verify": 0, "patch-orchestrate": 1, "dr-drill": 2 } as const;
    return out.sort((a, b) => order[a.capability] - order[b.capability]);
  }

  /**
   * Build (and cache) one signed sample report per capability for demos.
   * Refuses to run outside demo mode — the builders touch the real cluster.
   */
  private async demoSamples(): Promise<ResilienceReport[]> {
    if (!this.ctx.client.isDemo) return [];
    if (this.samplesCache) return this.samplesCache;
    const bv = await verifyBackups(this.ctx, {});
    const patch = await orchestratePatching(this.ctx, {});
    const dr = await runDrill(this.ctx, DEMO_RUNBOOK);
    const signedAt = nowIso();
    for (const r of [bv, patch, dr] as ResilienceReport[]) {
      const { signature, ...payload } = r;
      void signature;
      r.signature = signPayload(payload, this.keyPath, signedAt);
    }
    this.samplesCache = [bv, patch, dr];
    return this.samplesCache;
  }
}
