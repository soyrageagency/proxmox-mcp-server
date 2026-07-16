#!/usr/bin/env node
/**
 * One-command installer / configurator for beginners.
 *
 * Registers this Proxmox MCP Server in Claude Desktop with the correct absolute
 * path — no manual JSON editing. It builds first if needed, backs up any
 * existing config, and MERGES the entry so your other MCP servers are kept.
 * Proxmox credentials are read from `.env` (or the environment) if present.
 *
 *   node scripts/install.mjs           # configure Claude Desktop
 *   node scripts/install.mjs --print   # just print the JSON snippet
 *
 * Crafted by SoyRage Agency — https://soyrage.es/  ·  https://www.paypal.com/paypalme/soyrageagency
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist", "index.js");
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  blue: "\x1b[38;5;39m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
};
const say = (s) => process.stdout.write(s + "\n");
const ok = (s) => say(`${c.green}✓${c.reset} ${s}`);
const warn = (s) => say(`${c.yellow}!${c.reset} ${s}`);

say("");
say(`${c.blue}${c.bold}  Proxmox MCP Server — installer${c.reset}  ${c.dim}by SoyRage Agency${c.reset}`);
say(`${c.dim}  https://soyrage.es/${c.reset}`);
say("");

// 1) Ensure the project is built.
if (!existsSync(DIST)) {
  warn("Build output not found — building now (npm install && npm run build)…");
  const npm = platform() === "win32" ? "npm.cmd" : "npm";
  if (!existsSync(join(ROOT, "node_modules"))) run(npm, ["install"]);
  run(npm, ["run", "build"]);
}
if (!existsSync(DIST)) fail("Build failed: dist/index.js is still missing.");
ok(`Server built at ${c.dim}${DIST}${c.reset}`);

// 2) Read Proxmox credentials from .env / environment (best effort).
const env = readDotEnv(join(ROOT, ".env"));
const get = (k, dflt) => process.env[k] || env[k] || dflt;
const proxmoxEnv = {
  PROXMOX_HOST: get("PROXMOX_HOST", "https://192.168.1.10:8006"),
  PROXMOX_TOKEN_ID: get("PROXMOX_TOKEN_ID", "root@pam!mcp"),
  PROXMOX_TOKEN_SECRET: get("PROXMOX_TOKEN_SECRET", "REPLACE_WITH_YOUR_TOKEN_SECRET"),
  PROXMOX_VERIFY_TLS: get("PROXMOX_VERIFY_TLS", "false"),
  PROXMOX_MCP_READONLY: get("PROXMOX_MCP_READONLY", "false"),
};
const entry = { command: "node", args: [DIST], env: proxmoxEnv };

if (has("--print")) {
  say("");
  say(JSON.stringify({ mcpServers: { proxmox: entry } }, null, 2));
  say("");
  process.exit(0);
}

// 3) Locate the Claude Desktop config for this OS.
const configPath = claudeConfigPath();
if (!configPath) fail("Unsupported platform for auto-config. Use --print and paste it manually.");
say(`${c.dim}Target config:${c.reset} ${configPath}`);

// 4) Merge & write (with a backup).
let config = {};
if (existsSync(configPath)) {
  try { config = JSON.parse(readFileSync(configPath, "utf8")); }
  catch { warn("Existing config is not valid JSON; a fresh one will be written (old kept as .bak)."); }
  copyFileSync(configPath, configPath + ".bak");
  ok(`Backed up existing config → ${c.dim}${configPath}.bak${c.reset}`);
} else {
  mkdirSync(dirname(configPath), { recursive: true });
  warn("No existing config found — creating a new one. (Is Claude Desktop installed?)");
}

config.mcpServers = config.mcpServers || {};
const existed = Boolean(config.mcpServers.proxmox);
config.mcpServers.proxmox = entry;
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
ok(`${existed ? "Updated" : "Added"} the "proxmox" MCP server in your Claude config.`);

// 5) Guidance.
say("");
if (proxmoxEnv.PROXMOX_TOKEN_SECRET.startsWith("REPLACE")) {
  warn("No API token found. Create one in Proxmox (Datacenter → Permissions → API Tokens)");
  warn(`and set PROXMOX_HOST / PROXMOX_TOKEN_ID / PROXMOX_TOKEN_SECRET in ${c.bold}${configPath}${c.reset}`);
  say("");
}
say(`${c.green}${c.bold}  All set!${c.reset}`);
say(`  1. Fill in your Proxmox host + API token (above) if not already set.`);
say(`  2. Fully ${c.bold}restart Claude Desktop${c.reset}.`);
say(`  3. Ask it: ${c.blue}"List my Proxmox VMs and containers."${c.reset}`);
say("");
say(`  ${c.yellow}Support development:${c.reset} ${c.blue}https://www.paypal.com/paypalme/soyrageagency${c.reset}`);
say(`  ${c.yellow}★${c.reset} A star helps: ${c.blue}https://github.com/soyrageagency/proxmox-mcp-server${c.reset}`);
say("");

// ---- helpers --------------------------------------------------------------

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
