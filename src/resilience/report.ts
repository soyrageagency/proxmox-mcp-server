/**
 * Resilience evidence reports — control mapping, rendering & persistence.
 *
 * Turns a finished run into audit-grade artefacts: a signed JSON record
 * (machine-readable), a Markdown report (diff-able, lives in git) and a
 * branded HTML report that prints straight to PDF for an auditor. Each report
 * maps its result onto concrete ISO 27001 / NIS2 / DORA controls.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "../branding.js";
import type {
  BackupVerifyReport,
  Capability,
  ControlRef,
  DrReport,
  HealthCheck,
  Outcome,
  PatchReport,
  ResilienceReport,
  RunSummary,
} from "./types.js";

/** The compliance controls each capability produces evidence for. */
export const CONTROLS: Record<Capability, ControlRef[]> = {
  "backup-verify": [
    { framework: "ISO 27001", clause: "A.8.13", title: "Information backup" },
    { framework: "ISO 27001", clause: "A.5.29", title: "ICT readiness for business continuity" },
    { framework: "NIS2", clause: "Art. 21(2)(c)", title: "Backup management & crisis management" },
    { framework: "DORA", clause: "Art. 12", title: "Backup, restoration & recovery" },
  ],
  "patch-orchestrate": [
    { framework: "ISO 27001", clause: "A.8.8", title: "Management of technical vulnerabilities" },
    { framework: "ISO 27001", clause: "A.8.32", title: "Change management" },
    { framework: "NIS2", clause: "Art. 21(2)(e)", title: "Security in acquisition, development & maintenance" },
    { framework: "DORA", clause: "Art. 9", title: "Protection & prevention" },
  ],
  "dr-drill": [
    { framework: "ISO 27001", clause: "A.5.30", title: "ICT readiness for business continuity" },
    { framework: "NIS2", clause: "Art. 21(2)(c)", title: "Business continuity & disaster recovery" },
    { framework: "DORA", clause: "Art. 11", title: "Response & recovery" },
    { framework: "DORA", clause: "Art. 24-25", title: "Digital operational resilience testing" },
  ],
};

const MARK: Record<Outcome, string> = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP" };
const GLYPH: Record<Outcome, string> = { pass: "✓", fail: "✗", warn: "!", skip: "·" };
const HTML_COLOR: Record<Outcome, string> = { pass: "#2f9e57", fail: "#d64545", warn: "#c9922e", skip: "#8a95a8" };

/** Format seconds as "4m 12s" / "1h 03m" / "45s". */
export function dur(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** A one-line verdict banner for the console/MCP text result. */
export function verdict(r: ResilienceReport): string {
  const badge = MARK[r.outcome];
  return `[${badge}] ${r.title} — ${r.summary}`;
}

/** Reduce a report to a compact dashboard summary. */
export function summarize(r: ResilienceReport): RunSummary {
  let metric = "";
  if (r.capability === "backup-verify") {
    const checks = r.items.reduce((a, it) => a + it.checks.length, 0);
    const passed = r.items.reduce((a, it) => a + it.checks.filter((c) => c.outcome === "pass").length, 0);
    metric = `${passed}/${checks} checks · RTO ${dur(Math.max(0, ...r.items.map((i) => i.restoreSec)))}`;
  } else if (r.capability === "patch-orchestrate") {
    metric = `${r.patched} patched · ${r.rolledBack} rolled back`;
  } else {
    metric = `RTO ${dur(r.rtoSec)} · RPO ${dur(r.rpoSec)}`;
  }
  return {
    capability: r.capability,
    title: r.title,
    outcome: r.outcome,
    finishedAt: r.finishedAt,
    metric,
    signedBy: r.signature ? r.signature.keyFingerprint.slice(0, 12) : "",
    id: r.id,
  };
}

function checkLine(c: HealthCheck): string {
  const ms = c.ms !== undefined ? ` (${c.ms} ms)` : "";
  return `- ${GLYPH[c.outcome]} **${c.label}** — ${c.detail}${ms}`;
}

function controlsTable(controls: ControlRef[]): string {
  const rows = controls.map((c) => `| ${c.framework} | ${c.clause} | ${c.title} |`).join("\n");
  return `| Framework | Control | Title |\n| --- | --- | --- |\n${rows}`;
}

function signatureBlock(r: ResilienceReport): string {
  if (!r.signature) return "_Unsigned._";
  const s = r.signature;
  return [
    `- **Algorithm:** ${s.algorithm}`,
    `- **Signed at:** ${s.signedAt}`,
    `- **Payload SHA-256:** \`${s.digest}\``,
    `- **Signature (base64):** \`${s.signature}\``,
    `- **Key fingerprint:** \`${s.keyFingerprint}\``,
    "",
    "Verify offline with the bundled public key:",
    "",
    "```",
    s.publicKeyPem,
    "```",
  ].join("\n");
}

/** Render a report as a Markdown evidence document. */
export function renderMarkdown(r: ResilienceReport): string {
  const head = [
    `# ${r.title}`,
    "",
    `**Verdict:** ${MARK[r.outcome]}  ·  **Report ID:** \`${r.id}\`${r.demo ? "  ·  _demo data_" : ""}`,
    "",
    `- **Started:** ${r.startedAt}`,
    `- **Finished:** ${r.finishedAt}`,
    `- **Duration:** ${dur(r.durationSec)}`,
    `- **Summary:** ${r.summary}`,
    "",
  ];

  const body: string[] = [];
  if (r.capability === "backup-verify") {
    const rep = r as BackupVerifyReport;
    body.push(`## Verified backups`, "", `Ephemeral guests were fenced onto the isolated bridge \`${rep.isolatedBridge}\` and destroyed after testing.`, "");
    for (const it of rep.items) {
      body.push(
        `### ${GLYPH[it.outcome]} ${it.name} (VMID ${it.vmid})`,
        "",
        `- Archive: \`${it.archive}\` (age ${dur(it.archiveAgeSec)})`,
        `- Restored to ephemeral VMID ${it.ephemeralVmid} in **${dur(it.restoreSec)}** (measured RTO)`,
        `- Cleanup: ${it.cleanedUp ? "ephemeral guest destroyed ✓" : "**left behind — investigate**"}`,
        "",
        ...it.checks.map(checkLine),
        "",
      );
    }
  } else if (r.capability === "patch-orchestrate") {
    const rep = r as PatchReport;
    body.push(
      `## Patch run`,
      "",
      `Maintenance window: ${rep.window || "anytime"}. Guests are patched in dependency order; any guest failing its post-patch health check is rolled back to its pre-patch snapshot automatically.`,
      "",
      `| Batch | Guest | Snapshot | Updates | Health | Result |`,
      `| --- | --- | --- | --- | --- | --- |`,
      ...rep.steps.map(
        (s) =>
          `| ${s.batch} | ${s.name} (${s.vmid}) | \`${s.snapshot}\` | ${s.updates} | ${GLYPH[s.health.outcome]} ${s.health.detail} | ${s.rolledBack ? "ROLLED BACK" : MARK[s.outcome]} |`,
      ),
      "",
      `**${rep.patched} patched, ${rep.rolledBack} automatically rolled back.**`,
      "",
    );
  } else {
    const rep = r as DrReport;
    body.push(
      `## Disaster-recovery drill`,
      "",
      `- Runbook: **${rep.runbook}**`,
      `- Environment: **${rep.environment}** (never production)`,
      `- Measured RTO: **${dur(rep.rtoSec)}** · RPO: **${dur(rep.rpoSec)}**`,
      "",
      `| # | Action | Target | Result | Detail |`,
      `| --- | --- | --- | --- | --- |`,
      ...rep.steps.map(
        (s) => `| ${s.index} | ${s.action} | ${s.target} | ${GLYPH[s.outcome]} ${MARK[s.outcome]} | ${s.detail} |`,
      ),
      "",
    );
  }

  const tail = [
    `## Compliance mapping`,
    "",
    "This evidence supports the following controls:",
    "",
    controlsTable(r.controls),
    "",
    `## Signature`,
    "",
    signatureBlock(r),
    "",
    "---",
    "",
    `Generated by **${BRAND.product}** — ${BRAND.author} · ${BRAND.url}`,
    `Support the project: ${BRAND.donate}`,
    "",
  ];

  return [...head, ...body, ...tail].join("\n");
}

const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));

/** Render a branded, printable HTML evidence report. */
export function renderHtml(r: ResilienceReport): string {
  const accent = "#3b9ef0";
  const pill = (o: Outcome) =>
    `<span class="pill" style="background:${HTML_COLOR[o]}">${MARK[o]}</span>`;

  const detail: string[] = [];
  if (r.capability === "backup-verify") {
    const rep = r as BackupVerifyReport;
    detail.push(
      `<p class="muted">Ephemeral guests fenced onto isolated bridge <code>${esc(rep.isolatedBridge)}</code> and destroyed after testing.</p>`,
    );
    for (const it of rep.items) {
      detail.push(
        `<div class="card"><h3>${pill(it.outcome)} ${esc(it.name)} <span class="muted">VMID ${it.vmid}</span></h3>`,
        `<p class="muted">Archive <code>${esc(it.archive)}</code> · age ${dur(it.archiveAgeSec)} · restored to VMID ${it.ephemeralVmid} in <strong>${dur(it.restoreSec)}</strong> (RTO) · ${it.cleanedUp ? "cleaned up" : "<strong>not cleaned up</strong>"}</p>`,
        `<table class="checks">${it.checks
          .map(
            (c) =>
              `<tr><td class="g" style="color:${HTML_COLOR[c.outcome]}">${GLYPH[c.outcome]}</td><td>${esc(c.label)}</td><td class="muted">${esc(c.detail)}</td><td class="muted">${c.ms !== undefined ? c.ms + " ms" : ""}</td></tr>`,
          )
          .join("")}</table></div>`,
      );
    }
  } else if (r.capability === "patch-orchestrate") {
    const rep = r as PatchReport;
    detail.push(
      `<p class="muted">Maintenance window: ${esc(rep.window || "anytime")}. Patched in dependency order; failed health checks trigger an automatic rollback.</p>`,
      `<table class="grid"><tr><th>Batch</th><th>Guest</th><th>Snapshot</th><th>Updates</th><th>Health</th><th>Result</th></tr>`,
      ...rep.steps.map(
        (s) =>
          `<tr><td>${s.batch}</td><td>${esc(s.name)} <span class="muted">${s.vmid}</span></td><td><code>${esc(s.snapshot)}</code></td><td>${s.updates}</td><td style="color:${HTML_COLOR[s.health.outcome]}">${GLYPH[s.health.outcome]} ${esc(s.health.detail)}</td><td>${s.rolledBack ? '<span class="pill" style="background:' + HTML_COLOR.warn + '">ROLLED BACK</span>' : pill(s.outcome)}</td></tr>`,
      ),
      `</table><p><strong>${rep.patched} patched, ${rep.rolledBack} automatically rolled back.</strong></p>`,
    );
  } else {
    const rep = r as DrReport;
    detail.push(
      `<p class="muted">Runbook <strong>${esc(rep.runbook)}</strong> · environment <strong>${esc(rep.environment)}</strong> · RTO <strong>${dur(rep.rtoSec)}</strong> · RPO <strong>${dur(rep.rpoSec)}</strong></p>`,
      `<table class="grid"><tr><th>#</th><th>Action</th><th>Target</th><th>Result</th><th>Detail</th></tr>`,
      ...rep.steps.map(
        (s) =>
          `<tr><td>${s.index}</td><td>${esc(s.action)}</td><td>${esc(s.target)}</td><td style="color:${HTML_COLOR[s.outcome]}">${GLYPH[s.outcome]} ${MARK[s.outcome]}</td><td class="muted">${esc(s.detail)}</td></tr>`,
      ),
      `</table>`,
    );
  }

  const controls = r.controls
    .map((c) => `<tr><td><strong>${esc(c.framework)}</strong></td><td>${esc(c.clause)}</td><td>${esc(c.title)}</td></tr>`)
    .join("");

  const sig = r.signature;
  const sigHtml = sig
    ? `<table class="kv">
         <tr><td>Algorithm</td><td>${esc(sig.algorithm)}</td></tr>
         <tr><td>Signed at</td><td>${esc(sig.signedAt)}</td></tr>
         <tr><td>Payload SHA-256</td><td><code>${esc(sig.digest)}</code></td></tr>
         <tr><td>Signature</td><td><code class="wrap">${esc(sig.signature)}</code></td></tr>
         <tr><td>Key fingerprint</td><td><code>${esc(sig.keyFingerprint)}</code></td></tr>
       </table>
       <details><summary>Public key (verify offline)</summary><pre>${esc(sig.publicKeyPem)}</pre></details>`
    : "<p class='muted'>Unsigned.</p>";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(r.title)}</title>
<style>
  :root{--accent:${accent}}
  *{box-sizing:border-box}
  body{font:14px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1b2430;margin:0;background:#eef2f7}
  .page{max-width:900px;margin:0 auto;background:#fff;box-shadow:0 2px 24px rgba(20,40,80,.08)}
  header{background:linear-gradient(120deg,#0d1017,#17415f);color:#fff;padding:34px 40px}
  header .brand{font-weight:700;letter-spacing:.14em;color:var(--accent);font-size:12px}
  header h1{margin:.3em 0 .1em;font-size:24px}
  .pill{display:inline-block;color:#fff;border-radius:999px;padding:2px 12px;font-size:12px;font-weight:700;letter-spacing:.04em}
  main{padding:28px 40px 40px}
  h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:#5a6b82;border-bottom:2px solid #eef2f7;padding-bottom:6px;margin-top:32px}
  h3{font-size:15px;margin:.4em 0}
  .muted{color:#66768c}
  code{background:#f2f5fa;border-radius:4px;padding:1px 5px;font-size:12px}
  code.wrap{word-break:break-all}
  .meta{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:18px}
  .meta div{background:#f6f9fc;border:1px solid #e6ecf4;border-radius:10px;padding:12px 14px;color:#1b2430}
  .meta span{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8494a8}
  .meta strong{font-size:17px}
  table{width:100%;border-collapse:collapse;margin:10px 0}
  table.grid th,table.grid td{border-bottom:1px solid #eef2f7;padding:7px 8px;text-align:left;font-size:13px}
  table.grid th{color:#5a6b82;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  table.checks td{padding:4px 8px;border-bottom:1px solid #f4f7fb}
  table.checks td.g{width:20px;font-weight:700}
  table.kv td{padding:5px 8px;border-bottom:1px solid #f4f7fb;vertical-align:top}
  table.kv td:first-child{color:#66768c;width:150px}
  .card{border:1px solid #e6ecf4;border-radius:12px;padding:14px 16px;margin:12px 0;background:#fbfdff}
  pre{background:#0d1017;color:#c7d2e0;padding:12px;border-radius:8px;overflow:auto;font-size:11px}
  footer{padding:20px 40px;border-top:1px solid #eef2f7;color:#66768c;font-size:12px;display:flex;justify-content:space-between}
  a{color:var(--accent)}
  @media print{body{background:#fff}.page{box-shadow:none}}
</style></head><body><div class="page">
  <header>
    <div class="brand">SOYRAGE AGENCY · RESILIENCE EVIDENCE</div>
    <h1>${esc(r.title)}</h1>
    <div>${pill(r.outcome)} &nbsp;<span class="muted" style="color:#c7d2e0">Report ID ${esc(r.id)}${r.demo ? " · demo data" : ""}</span></div>
    <div class="meta">
      <div><span>Started</span><strong style="font-size:13px">${esc(r.startedAt.replace("T", " ").slice(0, 19))}</strong></div>
      <div><span>Finished</span><strong style="font-size:13px">${esc(r.finishedAt.replace("T", " ").slice(0, 19))}</strong></div>
      <div><span>Duration</span><strong>${dur(r.durationSec)}</strong></div>
      <div><span>Verdict</span><strong style="color:${HTML_COLOR[r.outcome]}">${MARK[r.outcome]}</strong></div>
    </div>
  </header>
  <main>
    <p>${esc(r.summary)}</p>
    <h2>Results</h2>
    ${detail.join("\n")}
    <h2>Compliance mapping</h2>
    <table class="grid"><tr><th>Framework</th><th>Control</th><th>Title</th></tr>${controls}</table>
    <h2>Signature</h2>
    ${sigHtml}
  </main>
  <footer>
    <span>Generated by ${esc(BRAND.product)} — ${esc(BRAND.author)}</span>
    <span><a href="${BRAND.url}">${esc(BRAND.url)}</a> · <a href="${BRAND.donate}">Support</a></span>
  </footer>
</div></body></html>`;
}

/** Paths written for one report. */
export interface ReportPaths {
  json: string;
  markdown: string;
  html: string;
}

/** Persist a report as JSON + Markdown + HTML under `outDir`. Returns paths. */
export function writeReports(r: ResilienceReport, outDir: string): ReportPaths {
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, r.id);
  const paths: ReportPaths = { json: `${base}.json`, markdown: `${base}.md`, html: `${base}.html` };
  writeFileSync(paths.json, JSON.stringify(r, null, 2));
  writeFileSync(paths.markdown, renderMarkdown(r));
  writeFileSync(paths.html, renderHtml(r));
  return paths;
}
