/**
 * Plugin registry & loader.
 *
 * The server is built as a set of independent *plugins*, each owning one
 * capability group. Which plugins load is fully driven by configuration.
 *
 * The `about` plugin is NON-DISABLEABLE: it carries the SoyRage Agency identity
 * and attribution, which the license requires to stay present.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { ToolContext } from "./tools/context.js";
import { registerAboutTool } from "./tools/about.js";
import { registerNodeTools } from "./tools/nodes.js";
import { registerGuestTools } from "./tools/guests.js";
import { registerClusterTools } from "./tools/cluster.js";
import { registerStorageTools } from "./tools/storage.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerSnapshotTools } from "./tools/snapshots.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import { registerManagementTools } from "./tools/management.js";
import { registerBackupTools } from "./tools/backups.js";
import { registerProvisioningTools } from "./tools/provisioning.js";

/** High-level grouping used for docs. */
export type PluginCategory =
  | "identity"
  | "nodes"
  | "guests"
  | "storage"
  | "tasks"
  | "cluster"
  | "snapshots"
  | "lifecycle"
  | "management"
  | "backups"
  | "provisioning";

/** A self-contained capability group that can be toggled on or off. */
export interface ToolPlugin {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly category: PluginCategory;
  readonly mutating: boolean;
  readonly locked?: boolean;
  readonly register: (ctx: ToolContext) => void;
}

/** The built-in plugin catalogue. */
export const BUILTIN_PLUGINS: readonly ToolPlugin[] = Object.freeze([
  {
    name: "about",
    title: "Identity & credits",
    description: "SoyRage Agency welcome banner, credits and license.",
    category: "identity",
    mutating: false,
    locked: true,
    register: registerAboutTool,
  },
  {
    name: "nodes",
    title: "Cluster nodes",
    description: "List nodes and read detailed node status.",
    category: "nodes",
    mutating: false,
    register: registerNodeTools,
  },
  {
    name: "guests",
    title: "VMs & containers",
    description: "List guests and read their status and configuration.",
    category: "guests",
    mutating: false,
    register: registerGuestTools,
  },
  {
    name: "storage",
    title: "Storage",
    description: "List storages and their usage on a node.",
    category: "storage",
    mutating: false,
    register: registerStorageTools,
  },
  {
    name: "tasks",
    title: "Tasks",
    description: "Recent task log on a node.",
    category: "tasks",
    mutating: false,
    register: registerTaskTools,
  },
  {
    name: "cluster",
    title: "Cluster",
    description: "Cluster status/quorum and a consolidated resource view.",
    category: "cluster",
    mutating: false,
    register: registerClusterTools,
  },
  {
    name: "snapshots",
    title: "Snapshots",
    description: "List snapshots and (unless read-only) create/rollback/delete.",
    category: "snapshots",
    mutating: true,
    register: registerSnapshotTools,
  },
  {
    name: "lifecycle",
    title: "Guest lifecycle",
    description: "Start, shutdown, stop, reboot, suspend and resume guests.",
    category: "lifecycle",
    mutating: true,
    register: registerLifecycleTools,
  },
  {
    name: "management",
    title: "Advanced management",
    description: "Migrate, clone, resize, backup and delete guests.",
    category: "management",
    mutating: true,
    register: registerManagementTools,
  },
  {
    name: "backups",
    title: "Backups (vzdump)",
    description: "List backup archives and (unless read-only) restore them.",
    category: "backups",
    mutating: true,
    register: registerBackupTools,
  },
  {
    name: "provisioning",
    title: "Provisioning",
    description: "List templates/ISOs and (unless read-only) create VMs and containers.",
    category: "provisioning",
    mutating: true,
    register: registerProvisioningTools,
  },
]);

/** Resolve which plugins should load, applying the enable/disable selection. */
export function selectPlugins(
  config: AppConfig,
  logger: Logger,
  catalogue: readonly ToolPlugin[] = BUILTIN_PLUGINS,
): ToolPlugin[] {
  const enabledSet = new Set(config.plugins.enabled);
  const disabledSet = new Set(config.plugins.disabled);

  const selected = catalogue.filter((plugin) => {
    if (plugin.locked) return true;
    if (enabledSet.size > 0 && !enabledSet.has(plugin.name)) return false;
    if (disabledSet.has(plugin.name)) return false;
    return true;
  });

  for (const name of disabledSet) {
    if (catalogue.find((p) => p.name === name)?.locked) {
      logger.warn(`Plugin "${name}" cannot be disabled (identity/attribution) and will still load.`);
    }
  }

  logger.info(`Plugins enabled: ${selected.map((p) => p.name).join(", ") || "(none)"}`);
  return selected;
}
