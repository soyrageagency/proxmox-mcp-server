#!/usr/bin/env node
/**
 * Guided installer / configurator for beginners.
 *
 * Run it and it walks you through everything: paste your Proxmox host + API
 * token, it tests the connection, then writes BOTH your `.env` and the Claude
 * Desktop config (merged, with a backup) so the AI works immediately.
 *
 *   node scripts/install.mjs            # interactive wizard (recommended)
 *   node scripts/install.mjs --yes      # non-interactive (read .env/environment)
 *   node scripts/install.mjs --print    # just print the Claude JSON snippet
 *
 * Crafted by SoyRage Agency — https://soyrage.es/  ·  https://www.paypal.com/paypalme/soyrageagency
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist", "index.js");
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  blue: "\x1b[38;5;39m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};
const say = (s = "") => process.stdout.write(s + "\n");
const ok = (s) => say(`${c.green}✓${c.reset} ${s}`);
const warn = (s) => say(`${c.yellow}!${c.reset} ${s}`);

// ---- Header ---------------------------------------------------------------
say();
say(`${c.blue}${c.bold}  Proxmox MCP Server — guided installer${c.reset}  ${c.dim}by SoyRage Agency${c.reset}`);
say(`${c.dim}  https://soyrage.es/${c.reset}`);
say();

// ---- 1) Ensure the project is built --------------------------------------
if (!existsSync(DIST)) {
  warn("Building the project first (npm install && npm run build)…");
  const npm = platform() === "win32" ? "npm.cmd" : "npm";
  if (!existsSync(join(ROOT, "node_modules"))) run(npm, ["install"]);
  run(npm, ["run", "build"]);
}
if (!existsSync(DIST)) fail("Build failed: dist/index.js is still missing.");

// ---- 2) Gather settings ---------------------------------------------------
const envFile = readDotEnv(join(ROOT, ".env"));
const interactive = (process.stdin.isTTY || has("--wizard")) && !has("--yes") && !has("--print");

let settings;
if (interactive) {
  settings = await wizard();
} else {
  // Non-interactive: read from environment / .env, fall back to placeholders.
  const get = (k, d) => process.env[k] || envFile[k] || d;
  settings = {
    host: get("PROXMOX_HOST", "https://192.168.1.10:8006"),
    tokenId: get("PROXMOX_TOKEN_ID", "root@pam!mcp"),
    tokenSecret: get("PROXMOX_TOKEN_SECRET", ""),
    user: get("PROXMOX_USER", ""),
    password: get("PROXMOX_PASSWORD", ""),
    verifyTls: get("PROXMOX_VERIFY_TLS", "false"),
    readOnly: get("PROXMOX_MCP_READONLY", "false"),
  };
}

// The env block baked into the Claude config.
const proxmoxEnv = cleanEnv({
  PROXMOX_HOST: settings.host,
  PROXMOX_TOKEN_ID: settings.tokenSecret ? settings.tokenId : "",
  PROXMOX_TOKEN_SECRET: settings.tokenSecret,
  PROXMOX_USER: settings.tokenSecret ? "" : settings.user,
  PROXMOX_PASSWORD: settings.tokenSecret ? "" : settings.password,
  PROXMOX_VERIFY_TLS: settings.verifyTls,
  PROXMOX_MCP_READONLY: settings.readOnly,
});
const entry = { command: "node", args: [DIST], env: proxmoxEnv };

if (has("--print")) {
  say();
  say(JSON.stringify({ mcpServers: { proxmox: entry } }, null, 2));
  say();
  process.exit(0);
}

// ---- 3) Write .env (so `npm run tui`/`inspect` work too) ------------------
writeEnvFile(join(ROOT, ".env"), proxmoxEnv);
ok(`Saved credentials to ${c.dim}${join(ROOT, ".env")}${c.reset}`);

// ---- 4) Merge into the Claude Desktop config ------------------------------
const configPath = claudeConfigPath();
if (!configPath) fail("Unsupported platform. Use --print and paste the snippet manually.");

let config = {};
if (existsSync(configPath)) {
  try { config = JSON.parse(readFileSync(configPath, "utf8")); }
  catch { warn("Existing Claude config isn't valid JSON; writing a fresh one (old kept as .bak)."); }
  copyFileSync(configPath, configPath + ".bak");
  ok(`Backed up Claude config → ${c.dim}${configPath}.bak${c.reset}`);
} else {
  mkdirSync(dirname(configPath), { recursive: true });
  warn("No Claude config found — creating one. (Is Claude Desktop installed?)");
}
config.mcpServers = config.mcpServers || {};
const existed = Boolean(config.mcpServers.proxmox);
config.mcpServers.proxmox = entry;
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
ok(`${existed ? "Updated" : "Added"} the "proxmox" server in your Claude config.`);

// ---- 5) Done --------------------------------------------------------------
say();
say(`${c.green}${c.bold}  All set!${c.reset}`);
say(`  1. Fully ${c.bold}restart Claude Desktop${c.reset} (quit from the tray, not just the window).`);
say(`  2. Ask it: ${c.blue}"List my Proxmox VMs and containers."${c.reset}`);
say();
say(`  ${c.dim}Terminal dashboard:${c.reset} ${c.bold}npm run tui${c.reset}   ·   ${c.dim}Try with mock data:${c.reset} ${c.bold}npm run tui:demo${c.reset}`);
say();
say(`  ${c.yellow}Enjoying it?${c.reset} Support development: ${c.blue}https://www.paypal.com/paypalme/soyrageagency${c.reset}`);
say(`  ${c.yellow}★${c.reset} A star helps a lot: ${c.blue}https://github.com/soyrageagency/proxmox-mcp-server${c.reset}`);
say();
process.exit(0);

// ===========================================================================
// The wizard
// ===========================================================================
async function wizard() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  // Line-queue so answers are read reliably whether typed live or piped.
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on("line", (l) => (waiters.length ? waiters.shift()(l) : queue.push(l)));
  rl.on("close", () => { closed = true; while (waiters.length) waiters.shift()(""); });
  const ask = (q) =>
    new Promise((res) => {
      process.stdout.write(q);
      if (queue.length) res(queue.shift());
      else if (closed) res("");
      else waiters.push(res);
    }).then((a) => String(a).trim());
  const askDef = async (label, def) => {
    const a = await ask(`  ${label}${def ? ` ${c.dim}[${def}]${c.reset}` : ""}: `);
    return a || def || "";
  };
  const yesNo = async (label, defYes) => {
    const a = (await ask(`  ${label} ${c.dim}(${defYes ? "Y/n" : "y/N"})${c.reset}: `)).toLowerCase();
    if (!a) return defYes;
    return a.startsWith("y");
  };

  say(`${c.bold}This wizard sets everything up in under a minute.${c.reset} You'll need:`);
  say(`  ${c.green}1.${c.reset} Your Proxmox web address ${c.dim}(the one you log in to)${c.reset}.`);
  say(`  ${c.green}2.${c.reset} An API token ${c.dim}(safest)${c.reset} — or your Proxmox username + password.`);
  say();
  say(`${c.dim}How to get a token in ~20s: Proxmox web UI → Datacenter → Permissions →${c.reset}`);
  say(`${c.dim}   API Tokens → Add → user 'root@pam', name 'mcp', then copy the secret.${c.reset}`);
  say();
  say(`${c.dim}Press Enter to accept a [default]. Nothing is saved until the end. Re-run 'npm run setup' anytime.${c.reset}`);
  say();

  // Host
  let host = await askDef(`Proxmox address ${c.dim}(e.g. https://192.168.1.10:8006)${c.reset}`, envFile.PROXMOX_HOST || "https://192.168.1.10:8006");
  if (!/^https?:\/\//i.test(host)) host = "https://" + host;
  if (!/:\d+/.test(host)) host = host.replace(/\/+$/, "") + ":8006";
  host = host.replace(/\/+$/, "");

  // Auth
  say();
  say(`  ${c.bold}Authentication${c.reset} — an API token is safest and revocable.`);
  say(`  ${c.dim}Create one in Proxmox: Datacenter → Permissions → API Tokens → Add${c.reset}`);
  const hasToken = await yesNo("Do you have an API token?", true);

  let tokenId = "", tokenSecret = "", user = "", password = "";
  if (hasToken) {
    tokenId = await askDef(`Token ID ${c.dim}(user@realm!name, e.g. root@pam!mcp)${c.reset}`, envFile.PROXMOX_TOKEN_ID || "root@pam!mcp");
    tokenSecret = await askDef(`Token secret ${c.dim}(paste the UUID)${c.reset}`, envFile.PROXMOX_TOKEN_SECRET || "");
    while (!tokenSecret) tokenSecret = await ask(`  ${c.yellow}Token secret is required${c.reset}: `);
  } else {
    say(`  ${c.dim}No problem — we'll use your username and password instead.${c.reset}`);
    user = await askDef(`Username ${c.dim}(user@realm, e.g. root@pam)${c.reset}`, envFile.PROXMOX_USER || "root@pam");
    password = await askDef("Password", envFile.PROXMOX_PASSWORD || "");
    while (!password) password = await ask(`  ${c.yellow}Password is required${c.reset}: `);
  }

  // TLS + read-only
  say();
  const verify = await yesNo(`Verify the TLS certificate? ${c.dim}(most Proxmox use self-signed → No)${c.reset}`, false);
  const readOnly = await yesNo(`Read-only mode? ${c.dim}(view only — safest; you can change later)${c.reset}`, false);

  // Test connection
  say();
  say(`  ${c.dim}Testing the connection…${c.reset}`);
  const headers = tokenSecret
    ? { Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}` }
    : null;
  const test = await testConnection(host, headers, user, password, verify);
  if (test.ok) ok(`Connected to Proxmox VE ${test.version ? c.dim + "(" + test.version + ")" + c.reset : ""}`);
  else {
    warn(`Could not verify the connection: ${test.error}`);
    const cont = await yesNo("Save these settings anyway?", true);
    if (!cont) { rl.close(); fail("Setup cancelled. Re-run `npm run setup` when ready."); }
  }

  rl.close();
  return {
    host,
    tokenId,
    tokenSecret,
    user,
    password,
    verifyTls: String(verify),
    readOnly: String(readOnly),
  };
}

async function testConnection(host, headers, user, password, verify) {
  try {
    const { Agent } = await import("undici");
    const dispatcher = new Agent({ connect: { rejectUnauthorized: !!verify } });
    let h = headers;
    if (!h && user && password) {
      // Ticket auth: log in first.
      const body = new URLSearchParams({ username: user, password }).toString();
      const login = await fetch(`${host}/api2/json/access/ticket`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, dispatcher,
      });
      if (!login.ok) return { ok: false, error: `login HTTP ${login.status}` };
      const t = (await login.json()).data;
      h = { Cookie: `PVEAuthCookie=${t.ticket}` };
    }
    const res = await fetch(`${host}/api2/json/version`, { headers: h || {}, dispatcher });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} (check host/token/permissions)` };
    const data = (await res.json()).data;
    return { ok: true, version: data?.version };
  } catch (e) {
    return { ok: false, error: e.code === "ENOTFOUND" || e.cause?.code === "ENOTFOUND" ? "host not found (check the address)" : (e.message || String(e)) };
  }
}

// ===========================================================================
// Helpers
// ===========================================================================
function cleanEnv(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== ""));
}

function writeEnvFile(path, env) {
  const lines = [
    "# Proxmox MCP Server — generated by the guided installer.",
    "# Crafted by SoyRage Agency — https://soyrage.es/",
    "",
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    "",
  ];
  if (existsSync(path)) copyFileSync(path, path + ".bak");
  writeFileSync(path, lines.join("\n"));
}

function claudeConfigPath() {
  const home = homedir();
  switch (platform()) {
    case "win32":
      return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "linux":
      return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "Claude", "claude_desktop_config.json");
    default:
      return null;
  }
}

function readDotEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) fail(`Command failed: ${cmd} ${args.join(" ")}`);
}

function fail(msg) {
  say(`${c.red}✗ ${msg}${c.reset}`);
  process.exit(1);
}
