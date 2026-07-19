/**
 * DR runbook parser (declarative YAML, dependency-free).
 *
 * Disaster-recovery drills are driven by a small, declarative runbook so the
 * plan lives in version control next to the infrastructure — not in a Word
 * document from 2019 that nobody has ever executed. This parses the safe subset
 * of YAML the runbook schema needs (top-level scalars + a `steps:` sequence of
 * mappings); a JSON runbook is accepted too.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

/** A single declarative recovery step. */
export interface RunbookStep {
  /** restore | start | healthcheck | verify-file | failover | notify | teardown | wait */
  action: string;
  guest?: string;
  /** Backup selector for `restore` (e.g. "latest"). */
  from?: string;
  /** Health check kind for `healthcheck` (service | db | http). */
  check?: string;
  /** File path for `verify-file`. */
  path?: string;
  /** Free-form note surfaced in the drill minutes. */
  note?: string;
}

/** A parsed, validated recovery runbook. */
export interface Runbook {
  name: string;
  /** Target environment — the drill refuses to touch anything named "production". */
  environment: string;
  description: string;
  /** Recovery Point Objective the drill asserts (hours). */
  rpoHours: number;
  steps: RunbookStep[];
}

const KNOWN_ACTIONS = new Set([
  "restore",
  "start",
  "healthcheck",
  "verify-file",
  "failover",
  "notify",
  "teardown",
  "wait",
]);

/** Strip surrounding quotes and unescape a scalar. */
function scalar(raw: string): string {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Indentation width (spaces) of a line. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Remove a trailing ` # comment`, respecting quoted strings. Keeps indentation. */
function stripInlineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i).replace(/\s+$/, "");
    }
  }
  return line;
}

/**
 * Parse a declarative runbook from YAML (subset) or JSON text. Throws a clear
 * error if the document is malformed or references an unknown action.
 */
export function parseRunbook(text: string): Runbook {
  const trimmed = text.trim();
  const raw: Record<string, unknown> = trimmed.startsWith("{")
    ? (JSON.parse(trimmed) as Record<string, unknown>)
    : parseYaml(trimmed);

  const name = String(raw.name ?? "").trim();
  if (!name) throw new Error("Runbook is missing a `name`.");
  const environment = String(raw.environment ?? "staging").trim();
  if (/prod/i.test(environment)) {
    throw new Error(
      `Runbook environment "${environment}" looks like production. DR drills must ` +
        "target an isolated test environment — refusing to run.",
    );
  }
  const stepsRaw = Array.isArray(raw.steps) ? (raw.steps as Array<Record<string, unknown>>) : [];
  if (stepsRaw.length === 0) throw new Error("Runbook has no `steps`.");

  const steps: RunbookStep[] = stepsRaw.map((s, i) => {
    const action = String(s.action ?? "").trim();
    if (!KNOWN_ACTIONS.has(action)) {
      throw new Error(
        `Step ${i + 1} has unknown action "${action}". Known actions: ${[...KNOWN_ACTIONS].join(", ")}.`,
      );
    }
    return {
      action,
      guest: s.guest !== undefined ? String(s.guest) : undefined,
      from: s.from !== undefined ? String(s.from) : undefined,
      check: s.check !== undefined ? String(s.check) : undefined,
      path: s.path !== undefined ? String(s.path) : undefined,
      note: s.note !== undefined ? String(s.note) : undefined,
    };
  });

  return {
    name,
    environment,
    description: String(raw.description ?? "").trim(),
    rpoHours: Number(raw.rpoHours ?? 24),
    steps,
  };
}

/**
 * Minimal YAML reader for the runbook schema: top-level `key: value` scalars
 * and a single `steps:` block that is a sequence of mappings. Deliberately not
 * a general YAML parser — it covers exactly what a runbook needs.
 */
function parseYaml(text: string): Record<string, unknown> {
  const lines = text
    .split(/\r?\n/)
    .map((l) => stripInlineComment(l.replace(/\t/g, "  ")))
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));

  const root: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (indentOf(line) !== 0) {
      throw new Error(`Unexpected indentation at: "${line.trim()}"`);
    }
    const colon = line.indexOf(":");
    if (colon === -1) throw new Error(`Expected "key: value" at: "${line.trim()}"`);
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();

    if (rest === "" && key === "steps") {
      const [items, next] = parseSequence(lines, i + 1);
      root[key] = items;
      i = next;
      continue;
    }
    root[key] = rest === "" ? "" : scalar(rest);
    i += 1;
  }
  return root;
}

/** Parse a sequence of mappings starting at `start`; returns [items, nextIndex]. */
function parseSequence(lines: string[], start: number): [Array<Record<string, unknown>>, number] {
  const items: Array<Record<string, unknown>> = [];
  let i = start;
  let itemIndent = -1;
  let current: Record<string, unknown> | null = null;

  while (i < lines.length) {
    const line = lines[i];
    const indent = indentOf(line);
    if (indent === 0) break; // back to top level
    const trimmed = line.trim();

    if (trimmed.startsWith("- ")) {
      if (itemIndent === -1) itemIndent = indent;
      if (indent !== itemIndent) break;
      current = {};
      items.push(current);
      const inline = trimmed.slice(2).trim();
      const colon = inline.indexOf(":");
      if (colon !== -1) current[inline.slice(0, colon).trim()] = scalar(inline.slice(colon + 1));
    } else if (current && indent > itemIndent) {
      const colon = trimmed.indexOf(":");
      if (colon !== -1) current[trimmed.slice(0, colon).trim()] = scalar(trimmed.slice(colon + 1));
    } else {
      break;
    }
    i += 1;
  }
  return [items, i];
}
