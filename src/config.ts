/**
 * Runtime configuration.
 *
 * Layered so the server is fully customisable without code changes. Precedence,
 * lowest to highest:
 *   1. Built-in defaults.
 *   2. An optional JSON config file (`proxmox-mcp.config.json`, or the path in
 *      `PROXMOX_MCP_CONFIG`).
 *   3. A local `.env` file.
 *   4. Real environment variables (what your MCP client passes).
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Supported diagnostic log levels, ordered by verbosity. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Shape of the optional JSON config file. All fields optional. */
interface FileConfig {
  host?: string;
  tokenId?: string;
  tokenSecret?: string;
  user?: string;
  password?: string;
  verifyTls?: boolean;
  readOnly?: boolean;
  demo?: boolean;
  allowlist?: string[];
  logLevel?: string;
  plugins?: { enabled?: string[]; disabled?: string[] };
}

/** Read and parse the JSON config file, if present. Never throws. */
function loadConfigFile(): FileConfig {
  const path = resolve(
    process.cwd(),
    process.env.PROXMOX_MCP_CONFIG?.trim() || "proxmox-mcp.config.json",
  );
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  } catch {
    process.stderr.write(
      `[proxmox-mcp] Warning: could not parse config file at ${path}; ignoring it.\n`,
    );
    return {};
  }
}

/** Minimal, dependency-free `.env` loader. Real env always wins. */
function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function envStr(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined ? fallback : value.trim();
}

function envList(name: string, fallback: readonly string[]): string[] {
  const value = process.env[name];
  if (value === undefined) return [...fallback];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Plugin enable/disable selection. */
export interface PluginSelection {
  readonly enabled: readonly string[];
  readonly disabled: readonly string[];
}

/** Fully-resolved, immutable server configuration. */
export interface AppConfig {
  /** Proxmox API base URL, e.g. https://host:8006 (no trailing slash). */
  readonly host: string;
  /** API token id "user@realm!tokenname" (preferred auth). */
  readonly tokenId: string;
  /** API token secret (UUID). */
  readonly tokenSecret: string;
  /** Username "user@realm" for ticket auth (fallback). */
  readonly user: string;
  /** Password for ticket auth (fallback). */
  readonly password: string;
  /** Whether to verify the node's TLS certificate. */
  readonly verifyTls: boolean;
  /** When true, all mutating tools are hidden. */
  readonly readOnly: boolean;
  /** When true, serve fabricated demo data instead of a real cluster. */
  readonly demo: boolean;
  /** Optional VMID/name allowlist (empty = allow all). */
  readonly allowlist: readonly string[];
  /** Diagnostic log level. */
  readonly logLevel: LogLevel;
  /** Modular plugin selection. */
  readonly plugins: PluginSelection;
}

/** Build the configuration object. Called once from the entry point. */
export function loadConfig(): AppConfig {
  const file = loadConfigFile();
  loadDotEnv();

  const rawLevel = envStr(
    "PROXMOX_MCP_LOG_LEVEL",
    file.logLevel ?? "info",
  ).toLowerCase();
  const logLevel: LogLevel = ["debug", "info", "warn", "error"].includes(rawLevel)
    ? (rawLevel as LogLevel)
    : "info";

  // Normalise host: ensure scheme, strip trailing slash.
  let host = envStr("PROXMOX_HOST", file.host ?? "");
  if (host && !/^https?:\/\//i.test(host)) host = `https://${host}`;
  host = host.replace(/\/+$/, "");

  return Object.freeze({
    host,
    tokenId: envStr("PROXMOX_TOKEN_ID", file.tokenId ?? ""),
    tokenSecret: envStr("PROXMOX_TOKEN_SECRET", file.tokenSecret ?? ""),
    user: envStr("PROXMOX_USER", file.user ?? ""),
    password: envStr("PROXMOX_PASSWORD", file.password ?? ""),
    verifyTls: envFlag("PROXMOX_VERIFY_TLS", file.verifyTls ?? false),
    readOnly: envFlag("PROXMOX_MCP_READONLY", file.readOnly ?? false),
    demo: envFlag("PROXMOX_MCP_DEMO", file.demo ?? false),
    allowlist: Object.freeze(envList("PROXMOX_MCP_ALLOWLIST", file.allowlist ?? [])),
    logLevel,
    plugins: Object.freeze({
      enabled: Object.freeze(
        envList("PROXMOX_MCP_PLUGINS", file.plugins?.enabled ?? []),
      ),
      disabled: Object.freeze(
        envList("PROXMOX_MCP_DISABLED_PLUGINS", file.plugins?.disabled ?? []),
      ),
    }),
  });
}
