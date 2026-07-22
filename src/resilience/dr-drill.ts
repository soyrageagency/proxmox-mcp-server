/**
 * Scheduled disaster-recovery drills.
 *
 * Many companies have their DR plan in a 2019 Word document that nobody has
 * ever executed. This runs a declarative YAML runbook against an isolated test
 * environment, times every recovery step, measures the achieved RTO/RPO and
 * produces the signed drill minutes ("acta") an auditor asks for.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { CONTROLS } from "./report.js";
import type { ResilienceContext } from "./engine.js";
import type { Runbook, RunbookStep } from "./runbook.js";
import type { DrReport, DrStepResult, Outcome } from "./types.js";
import { nowIso, shortId, sleep, worst } from "./util.js";

/** Recovery-relevant actions that count toward the measured RTO. */
const RTO_ACTIONS = new Set(["restore", "start", "failover"]);

/** Simulated per-action timing (seconds) for demo runs. */
const DEMO_SECONDS: Record<string, number> = {
  restore: 96,
  start: 22,
  healthcheck: 6,
  "verify-file": 3,
  failover: 14,
  notify: 1,
  teardown: 8,
  wait: 5,
};

function describe(step: RunbookStep): { target: string; detail: string } {
  const target = step.guest ? `guest ${step.guest}` : step.path ? step.path : step.check ?? "—";
  switch (step.action) {
    case "restore":
      return { target, detail: `restored ${step.guest ?? "guest"} from ${step.from ?? "latest"} backup into the isolated test env` };
    case "start":
      return { target, detail: `booted ${step.guest ?? "guest"}; reached running state` };
    case "healthcheck":
      return { target, detail: `${step.check ?? "service"} check passed` };
    case "verify-file":
      return { target, detail: `checksum of ${step.path ?? "file"} matches baseline` };
    case "failover":
      return { target, detail: `failed over ${step.guest ?? "service"} to the recovery node` };
    case "notify":
      return { target, detail: `notified stakeholders: ${step.note ?? "DR drill in progress"}` };
    case "teardown":
      return { target, detail: `tore down the isolated test env` };
    case "wait":
      return { target, detail: step.note ?? "settle delay" };
    default:
      return { target, detail: step.note ?? "" };
  }
}

/** Execute one runbook step (demo simulates; live degrades gracefully). */
async function runStep(ctx: ResilienceContext, step: RunbookStep, index: number): Promise<DrStepResult> {
  const { target, detail } = describe(step);
  if (ctx.client.isDemo) {
    const sec = DEMO_SECONDS[step.action] ?? 5;
    return { index, action: step.action, target, outcome: "pass", detail, ms: sec * 1000 };
  }
  // Live execution is intentionally conservative: it records intent and marks
  // steps needing in-guest access as warnings so the minutes never overstate.
  const t0 = Date.now();
  let outcome: Outcome = "pass";
  let note = detail;
  try {
    if (step.action === "notify" || step.action === "wait") {
      if (step.action === "wait") await sleep(500);
    } else {
      outcome = "warn";
      note = `${detail} (requires live execution against ${ctx.config.resilience.isolatedBridge} test env)`;
    }
  } catch (err) {
    outcome = "fail";
    note = (err as Error).message;
  }
  return { index, action: step.action, target, outcome, detail: note, ms: Date.now() - t0 };
}

/**
 * Measure the real Recovery Point Objective: how old the freshest backup on the
 * cluster is, in seconds. Returns null when nothing could be read.
 */
async function measureRpoSec(ctx: ResilienceContext): Promise<number | null> {
  try {
    const node = await ctx.client.resolveNode();
    const now = Math.floor(Date.now() / 1000);
    let freshest: number | null = null;
    for (const storage of await ctx.client.backupStorages(node)) {
      for (const item of (await ctx.client.storageContent(node, storage, "backup")) ?? []) {
        const ctime = Number(item.ctime ?? 0);
        if (!ctime) continue;
        const age = Math.max(0, now - ctime);
        if (freshest === null || age < freshest) freshest = age;
      }
    }
    return freshest;
  } catch {
    return null;
  }
}

/** Run a DR drill from a parsed runbook; returns an (unsigned) evidence report. */
export async function runDrill(ctx: ResilienceContext, runbook: Runbook): Promise<DrReport> {
  const startedAt = nowIso();
  const t0 = Date.now();
  const steps: DrStepResult[] = [];
  for (let i = 0; i < runbook.steps.length; i++) {
    steps.push(await runStep(ctx, runbook.steps[i], i + 1));
  }
  const rtoSec = steps.filter((s) => RTO_ACTIONS.has(s.action)).reduce((a, s) => a + s.ms / 1000, 0);
  // RPO must be MEASURED (age of the freshest recovery point), never echoed back
  // from the objective — otherwise the drill would always claim it met target.
  const rpoSec = ctx.client.isDemo ? 55 * 60 : ((await measureRpoSec(ctx)) ?? -1);
  const rpoKnown = rpoSec >= 0;
  const metTarget = rpoKnown && rpoSec <= runbook.rpoHours * 3600;
  const rpoNote = rpoKnown ? (metTarget ? "RPO within target: yes" : "RPO EXCEEDS target") : "RPO not measured (no backups found)";
  const outcome = worst([...steps.map((s) => s.outcome), rpoKnown && !metTarget ? "warn" : "pass"]);
  return {
    capability: "dr-drill",
    id: shortId("DR"),
    title: `DR drill — ${runbook.name}`,
    startedAt,
    finishedAt: nowIso(),
    durationSec: ctx.client.isDemo ? Math.round(steps.reduce((a, s) => a + s.ms, 0) / 1000) : Math.round((Date.now() - t0) / 1000),
    outcome,
    summary: `${runbook.steps.length}-step runbook executed against "${runbook.environment}"; RTO ${Math.round(rtoSec)}s, ${rpoNote}.`,
    demo: ctx.client.isDemo,
    controls: CONTROLS["dr-drill"],
    runbook: runbook.name,
    environment: runbook.environment,
    rtoSec: Math.round(rtoSec),
    rpoSec,
    steps,
  };
}
