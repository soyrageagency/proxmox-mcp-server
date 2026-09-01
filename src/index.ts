#!/usr/bin/env node
/**
 * Proxmox MCP Server — entry point.
 *
 * Boots a Model Context Protocol server over stdio that lets any MCP-capable
 * LLM (Claude Desktop, Cursor, Continue, …) manage a Proxmox VE cluster in
 * natural language: list nodes, VMs and containers, read status, control the
 * guest lifecycle and take snapshots — with read-only and allowlist safety.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * MIT licensed (see LICENSE).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttpTransport } from "./transport/http.js";
import { loadConfig } from "./config.js";
import { updateNoticeLine } from "./update/notice.js";
import { Logger } from "./logger.js";
import { ProxmoxClient } from "./proxmox/client.js";
import { BUILTIN_PLUGINS, selectPlugins } from "./plugins.js";
import type { PluginInfo } from "./tools/context.js";
import { ASCII_BANNER, BRAND, mcpInstructions } from "./branding.js";

const SERVER_NAME = "proxmox-mcp-server";
const SERVER_VERSION = BRAND.version;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  // Welcome banner → stderr (stdout is the JSON-RPC stream).
  process.stderr.write(`${ASCII_BANNER}\n`);
  process.stderr.write(
    `  ${BRAND.product} v${BRAND.version} — by ${BRAND.author} (${BRAND.url})\n\n`,
  );

  logger.info(`Starting ${SERVER_NAME} v${SERVER_VERSION}`);
  logger.debug("Configuration", {
    host: config.host || "(not configured)",
    auth: config.tokenSecret ? "api-token" : config.password ? "ticket" : "(none)",
    readOnly: config.readOnly,
    allowlist: config.allowlist,
  });

  const proxmox = new ProxmoxClient(config, logger);

  // Fail soft: probe the API but keep starting so tool calls return clean
  // errors inside the chat client instead of a hard crash.
  if (config.demo) {
    logger.info("DEMO mode: serving fabricated cluster data (no real Proxmox needed).");
  } else if (config.host && (config.tokenSecret || config.password)) {
    try {
      await proxmox.ping();
      logger.info(`Connected to Proxmox VE at ${config.host}.`);
    } catch (error) {
      logger.error(
        "Could not reach the Proxmox API. Check PROXMOX_HOST, credentials and TLS settings.",
        error,
      );
    }
  } else {
    logger.warn("Proxmox host/credentials not configured — set them, or try PROXMOX_MCP_DEMO=true.");
  }

  // Resolve the modular plugin selection once; every server instance registers
  // the same set.
  const selected = selectPlugins(config, logger);
  const enabledNames = new Set(selected.map((p) => p.name));
  const pluginInfo: PluginInfo[] = BUILTIN_PLUGINS.map((p) => ({
    name: p.name,
    title: p.title,
    category: p.category,
    mutating: p.mutating,
    enabled: enabledNames.has(p.name),
  }));

  /**
   * Build a fully wired server. Over HTTP this is called once per session, so
   * it must not share mutable state between calls.
   */
  const createMcpServer = (): McpServer => {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { instructions: mcpInstructions() },
    );
    const context = { server, proxmox, config, logger, plugins: pluginInfo };
    for (const plugin of selected) plugin.register(context);
    return server;
  };

  logger.info(
    config.readOnly
      ? "Tools registered in READ-ONLY mode."
      : "Tools registered in full read/write mode.",
  );

  let stop: () => Promise<void>;
  if (config.http.enabled) {
    stop = await startHttpTransport(config.http, createMcpServer, logger);
  } else {
    const server = createMcpServer();
    await server.connect(new StdioServerTransport());
    logger.info("MCP server is ready and listening on stdio.");
    stop = () => server.close();
  }

  // Non-blocking: note if a newer version is available (logs to stderr only).
  void updateNoticeLine().then((line) => { if (line) logger.info(line); }).catch(() => {});

  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down.`);
    void stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
