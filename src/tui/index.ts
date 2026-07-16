#!/usr/bin/env node
/**
 * Terminal UI — entry point.
 *
 * The `proxmox-mcp-tui` binary: a creative, lazydocker-style terminal dashboard
 * for your Proxmox VE cluster, opening with a SoyRage Agency welcome. Reuses
 * the same configuration, Proxmox client and safety rails as the MCP server.
 *
 * Preview it with no cluster:
 *   PROXMOX_MCP_DEMO=true npm run tui
 *
 * Non-interactive snapshot modes (for documentation):
 *   node dist/tui/index.js --frame
 *   node dist/tui/index.js --splash
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { loadConfig } from "../config.js";
import { Logger } from "../logger.js";
import { ProxmoxClient } from "../proxmox/client.js";
import { TuiApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger("error", "tui"); // stay quiet: the TUI owns the terminal

  const client = new ProxmoxClient(config, logger);
  if (!config.demo) {
    if (!config.host || (!config.tokenSecret && !config.password)) {
      process.stderr.write(
        "Proxmox host/credentials not configured. Launch with PROXMOX_MCP_DEMO=true to preview with mock data.\n",
      );
      process.exit(1);
    }
    try {
      await client.ping();
    } catch {
      process.stderr.write(
        "Could not reach the Proxmox API. Check PROXMOX_HOST/credentials, or use PROXMOX_MCP_DEMO=true.\n",
      );
      process.exit(1);
    }
  }

  const app = new TuiApp(client, config);

  if (process.argv.includes("--splash")) {
    process.stdout.write(app.splashLines(96, 22).join("\n") + "\n");
    process.exit(0);
  }
  if (process.argv.includes("--frame")) {
    const viewArg = (process.argv.find((a) => a.startsWith("--view=")) || "").split("=")[1];
    const view = ["guests", "nodes", "storage", "tasks"].includes(viewArg) ? viewArg : "guests";
    process.stdout.write((await app.frame(98, 30, view)) + "\n");
    process.exit(0);
  }

  await app.start();
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
