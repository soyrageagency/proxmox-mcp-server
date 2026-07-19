/**
 * Smoke test — verifies the MCP server boots and registers the expected tools
 * in full and read-only modes, and that the SoyRage identity is present.
 *
 * Needs no Proxmox host (tools register regardless; calls would error cleanly).
 * Exits non-zero on failure.
 *
 * Crafted by SoyRage Agency — https://soyrage.es/
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results = [];
const ok = (name, cond, detail = "") => results.push({ name, ok: !!cond, detail });

/** Run a JSON-RPC batch against the MCP server, return responses. */
function mcp(env, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/index.js"], { env: { ...process.env, PROXMOX_MCP_LOG_LEVEL: "error", ...env } });
    let buf = ""; const out = [];
    const timer = setTimeout(() => { child.kill(); resolve(out); }, 8000);
    child.stdout.on("data", (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch {}
      }
      if (out.filter((m) => m.id !== undefined).length >= requests.filter((r) => r.id !== undefined).length) {
        clearTimeout(timer); child.kill(); resolve(out);
      }
    });
    child.on("error", reject);
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
  });
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } };
const notif = { jsonrpc: "2.0", method: "notifications/initialized" };
const listReq = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
const aboutReq = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "about", arguments: {} } };

const full = await mcp({}, [init, notif, listReq, aboutReq]);
const initRes = full.find((m) => m.id === 1);
ok("initialize returns SoyRage instructions", initRes?.result?.instructions?.includes("SoyRage Agency"));
const tools = full.find((m) => m.id === 2)?.result?.tools?.map((t) => t.name) || [];
ok("full mode exposes 36 tools", tools.length === 36, `got ${tools.length}`);
ok("has lifecycle & snapshot tools", tools.includes("start_guest") && tools.includes("create_snapshot"));
ok("has suspend/resume", tools.includes("suspend_guest") && tools.includes("resume_guest"));
ok("has OS info tool", tools.includes("guest_osinfo"));
ok("has advanced management", tools.includes("migrate_guest") && tools.includes("clone_guest") && tools.includes("backup_guest") && tools.includes("delete_guest") && tools.includes("set_guest_resources"));
ok("has backups list/restore", tools.includes("list_backups") && tools.includes("restore_backup"));
ok("has provisioning (templates + create)", tools.includes("list_templates") && tools.includes("create_container") && tools.includes("create_vm"));
ok("has resilience suite", tools.includes("verify_backups") && tools.includes("orchestrate_patching") && tools.includes("run_dr_drill") && tools.includes("list_resilience_reports"));
ok("has cluster/guest insight", tools.includes("list_guests") && tools.includes("cluster_resources"));
const about = full.find((m) => m.id === 3)?.result?.content?.[0]?.text || "";
ok("about shows PayPal + author", about.includes("paypalme/soyrageagency") && about.includes("SoyRage Agency"));

const ro = await mcp({ PROXMOX_MCP_READONLY: "true" }, [init, notif, listReq]);
const roTools = ro.find((m) => m.id === 2)?.result?.tools?.map((t) => t.name) || [];
ok("read-only hides all writes", !roTools.includes("start_guest") && !roTools.includes("create_snapshot") && !roTools.includes("migrate_guest") && !roTools.includes("delete_guest") && !roTools.includes("restore_backup") && !roTools.includes("create_vm"));
ok("read-only hides resilience runs, keeps report listing", !roTools.includes("verify_backups") && !roTools.includes("orchestrate_patching") && !roTools.includes("run_dr_drill") && roTools.includes("list_resilience_reports"));
ok("read-only keeps insight (incl. osinfo/backups/templates)", roTools.includes("list_guests") && roTools.includes("guest_osinfo") && roTools.includes("list_backups") && roTools.includes("list_templates"));

const plug = await mcp({ PROXMOX_MCP_DISABLED_PLUGINS: "lifecycle" }, [init, notif, listReq]);
const plugTools = plug.find((m) => m.id === 2)?.result?.tools?.map((t) => t.name) || [];
ok("plugin disable removes lifecycle", !plugTools.includes("start_guest"));

// Demo mode: tools should return real (fabricated) data without a host.
const callGuests = { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_guests", arguments: {} } };
const callNodes = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_nodes", arguments: {} } };
const demo = await mcp({ PROXMOX_MCP_DEMO: "true" }, [init, notif, callGuests, callNodes]);
const gText = demo.find((m) => m.id === 4)?.result?.content?.[0]?.text || "";
const nText = demo.find((m) => m.id === 5)?.result?.content?.[0]?.text || "";
ok("demo list_guests returns VMs & containers", gText.includes("web") && gText.includes("grafana") && /VM|CT/.test(gText));
ok("demo list_nodes returns nodes", nText.includes("pve") && nText.includes("online"));

// Resilience: verifying a backup produces a signed, compliance-mapped report.
const callVerify = { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "verify_backups", arguments: {} } };
const callDrill = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "run_dr_drill", arguments: {} } };
const resDir = join(tmpdir(), `pmx-smoke-${process.pid}`);
const res = await mcp({ PROXMOX_MCP_DEMO: "true", PROXMOX_MCP_RESILIENCE_DIR: resDir }, [init, notif, callVerify, callDrill]);
const vText = res.find((m) => m.id === 6)?.result?.content?.[0]?.text || "";
const dText = res.find((m) => m.id === 7)?.result?.content?.[0]?.text || "";
ok("verify_backups returns a signed, mapped evidence report", /\[(PASS|WARN|FAIL)\]/.test(vText) && vText.includes("ed25519") && vText.includes("ISO 27001"));
ok("run_dr_drill returns signed drill minutes", /\[(PASS|WARN|FAIL)\]/.test(dText) && dText.includes("Evidence:") && dText.includes("DORA"));

let pass = 0, fail = 0;
for (const r of results) {
  if (r.ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${r.name}`); }
  else { fail++; console.log(`  \x1b[31m✗ ${r.name}\x1b[0m  ${r.detail}`); }
}
console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
