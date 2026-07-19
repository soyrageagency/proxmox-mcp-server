/**
 * Resilience & Compliance tools.
 *
 * Read-only:
 *   • list_resilience_reports — recent signed evidence reports.
 *
 * State-changing (skipped in read-only mode):
 *   • verify_backups          — restore the latest backup(s) into an isolated
 *                               ephemeral VM, health-check, destroy, sign a report.
 *   • orchestrate_patching    — snapshot → patch → health-check → auto-rollback.
 *   • run_dr_drill            — execute a declarative YAML runbook, sign the minutes.
 *
 * Every run writes JSON + Markdown + HTML evidence and returns a verdict plus
 * the ISO 27001 / NIS2 / DORA controls it supports.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ToolContext } from "./context.js";
import { guard, ok } from "../utils/result.js";
import { renderTable } from "../utils/format.js";
import { ResilienceEngine, DEMO_RUNBOOK, type RunResult } from "../resilience/engine.js";
import { dur, verdict } from "../resilience/report.js";

/** Render a finished run into an MCP text result. */
function renderRun(result: RunResult): string {
  const { report, paths } = result;
  const controls = report.controls.map((c) => `${c.framework} ${c.clause}`).join(", ");
  const sig = report.signature;
  return [
    verdict(report),
    "",
    `Duration: ${dur(report.durationSec)}${report.demo ? "   (demo data)" : ""}`,
    `Evidence: ${paths.markdown}`,
    `          ${paths.html}`,
    `          ${paths.json}`,
    sig ? `Signed:   ed25519 · key ${sig.keyFingerprint} · ${sig.signedAt}` : "Signed:   (unsigned)",
    "",
    `Supports controls: ${controls}`,
  ].join("\n");
}

export function registerResilienceTools(ctx: ToolContext): void {
  const { server, config, logger } = ctx;
  const engine = new ResilienceEngine({ client: ctx.proxmox, config, logger });

  // ---- Read-only: recent evidence ----------------------------------------
  server.registerTool(
    "list_resilience_reports",
    {
      title: "List resilience reports",
      description:
        "List the most recent signed resilience evidence reports (backup " +
        "verification, patch orchestration, DR drills) with their verdict and metric.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const summaries = await engine.recentSummaries();
        if (summaries.length === 0) return ok("No resilience reports yet. Run verify_backups, orchestrate_patching or run_dr_drill.");
        const rows = summaries.map((s) => [
          s.capability,
          s.outcome.toUpperCase(),
          s.metric,
          s.finishedAt.replace("T", " ").slice(0, 16),
          s.signedBy || "—",
        ]);
        const table = renderTable(["CAPABILITY", "VERDICT", "METRIC", "FINISHED", "SIGNED-BY"], rows);
        return ok(`Recent resilience evidence:\n\n${table}`);
      }),
  );

  if (config.readOnly) {
    logger.info("Read-only mode: resilience run tools (verify/patch/drill) are disabled.");
    return;
  }

  // ---- Backup verification -----------------------------------------------
  server.registerTool(
    "verify_backups",
    {
      title: "Verify backups (restore test)",
      description:
        "Restore the latest vzdump backup(s) into an ISOLATED, ephemeral VM, boot it, " +
        "run health checks (service up, database responds, key-file checksums), then " +
        "destroy the ephemeral guest — and emit a signed, dated evidence report. Verify " +
        "one guest with `vmid`, or omit it to test the latest backup of every guest.",
      inputSchema: {
        vmid: z.number().int().positive().optional().describe("Only verify this VMID's latest backup."),
        node: z.string().optional().describe("Node to restore on (default: first node)."),
      },
    },
    async ({ vmid, node }) => guard(async () => ok(renderRun(await engine.verifyBackups({ vmid, node })))),
  );

  // ---- Patch orchestration -----------------------------------------------
  server.registerTool(
    "orchestrate_patching",
    {
      title: "Patch with automatic rollback",
      description:
        "Patch guests safely: for each one, take a pre-patch snapshot, apply updates, run a " +
        "health check, and AUTOMATICALLY roll back to the snapshot if the health check fails. " +
        "Guests are processed in dependency order within an optional maintenance window. " +
        "Emits a signed evidence report.",
      inputSchema: {
        guests: z.array(z.string()).optional().describe("VMIDs/names to patch (default: all running guests)."),
        window: z.string().optional().describe('Maintenance window, e.g. "Sat 02:00-05:00" (default: configured).'),
      },
    },
    async ({ guests, window }) => guard(async () => ok(renderRun(await engine.orchestratePatching({ guests, window })))),
  );

  // ---- DR drill -----------------------------------------------------------
  server.registerTool(
    "run_dr_drill",
    {
      title: "Run a DR drill",
      description:
        "Execute a declarative disaster-recovery runbook (YAML or JSON) against an isolated " +
        "test environment, measure the achieved RTO/RPO, and produce the signed drill minutes. " +
        "Provide the runbook inline via `runbook`, a file via `path`, or omit both to run the " +
        "built-in sample runbook.",
      inputSchema: {
        runbook: z.string().optional().describe("Runbook text (YAML or JSON)."),
        path: z.string().optional().describe("Path to a runbook file on disk."),
      },
    },
    async ({ runbook, path }) =>
      guard(async () => {
        let result: RunResult;
        if (runbook) result = await engine.runDrill(runbook);
        else if (path) result = await engine.runDrill(readFileSync(path, "utf8"));
        else result = await engine.runDrillObject(DEMO_RUNBOOK);
        return ok(renderRun(result));
      }),
  );
}
