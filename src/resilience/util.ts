/**
 * Small shared helpers for the resilience engine.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { randomBytes } from "node:crypto";
import type { Outcome } from "./types.js";

const SEVERITY: Record<Outcome, number> = { pass: 0, skip: 1, warn: 2, fail: 3 };

/** Reduce a set of outcomes to the worst (fail > warn > skip > pass). */
export function worst(outcomes: Outcome[]): Outcome {
  let acc: Outcome = "pass";
  for (const o of outcomes) if (SEVERITY[o] > SEVERITY[acc]) acc = o;
  return acc;
}

/** Current time as an ISO-8601 string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** A short, sortable report id, e.g. "BV-20260719-9f3a". */
export function shortId(prefix: string): string {
  const d = new Date();
  const stamp =
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `${prefix}-${stamp}-${randomBytes(2).toString("hex")}`;
}

/** Promise-based delay. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
