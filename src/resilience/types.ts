/**
 * Resilience & Compliance — shared types.
 *
 * The three capabilities in this module (automated backup verification,
 * patch orchestration with automatic rollback, and scheduled DR drills) all
 * produce the same shape of artefact: a dated, cryptographically-signed
 * evidence report that maps its result onto ISO 27001, NIS2 and DORA controls.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

/** The three resilience capabilities, used as report kinds and TUI rows. */
export type Capability = "backup-verify" | "patch-orchestrate" | "dr-drill";

/** Outcome of a single check or step. */
export type Outcome = "pass" | "fail" | "warn" | "skip";

/** A single health check run against a guest (service up, DB, checksum…). */
export interface HealthCheck {
  /** Stable id, e.g. "service-up", "db-responds", "checksum:/etc/app.conf". */
  id: string;
  /** Human label shown in the report. */
  label: string;
  outcome: Outcome;
  /** One-line detail (measured value, error, checksum…). */
  detail: string;
  /** Milliseconds the check took (when measured). */
  ms?: number;
}

/** A cryptographic signature block proving the report is authentic & unaltered. */
export interface Signature {
  algorithm: string; // "ed25519"
  /** SHA-256 digest (hex) of the canonical report payload. */
  digest: string;
  /** Detached signature (base64) over the digest. */
  signature: string;
  /** SHA-256 fingerprint (hex, truncated) of the signing public key. */
  keyFingerprint: string;
  /** The signing public key in SPKI PEM, so an auditor can verify offline. */
  publicKeyPem: string;
  /** ISO-8601 timestamp the report was signed. */
  signedAt: string;
}

/** A reference to a compliance control this evidence helps satisfy. */
export interface ControlRef {
  framework: "ISO 27001" | "NIS2" | "DORA";
  clause: string;
  title: string;
}

/** Common envelope fields shared by every resilience report. */
export interface ReportBase {
  capability: Capability;
  /** Short unique id, e.g. "BV-20260719-1a2b". */
  id: string;
  title: string;
  /** ISO-8601 start/end. */
  startedAt: string;
  finishedAt: string;
  /** Wall-clock duration in seconds. */
  durationSec: number;
  /** Overall verdict. */
  outcome: Outcome;
  /** Human one-line summary. */
  summary: string;
  /** Whether this ran against fabricated demo data. */
  demo: boolean;
  /** Controls this run produces evidence for. */
  controls: ControlRef[];
  /** Signature (added last, over everything above). */
  signature?: Signature;
}

// ---- Backup verification ---------------------------------------------------

export interface BackupVerifyItem {
  vmid: number;
  name: string;
  /** The archive that was restored. */
  archive: string;
  /** Archive age at verification time, seconds. */
  archiveAgeSec: number;
  /** Ephemeral VMID the restore landed on. */
  ephemeralVmid: number;
  /** Restore + boot time (measured RTO), seconds. */
  restoreSec: number;
  checks: HealthCheck[];
  outcome: Outcome;
  /** Whether the isolated ephemeral guest was torn down cleanly. */
  cleanedUp: boolean;
}

export interface BackupVerifyReport extends ReportBase {
  capability: "backup-verify";
  /** Isolated bridge the ephemeral guests were fenced onto. */
  isolatedBridge: string;
  items: BackupVerifyItem[];
}

// ---- Patch orchestration ---------------------------------------------------

export interface PatchStep {
  vmid: number;
  name: string;
  /** Dependency batch index (lower = patched first). */
  batch: number;
  /** Pre-patch safety snapshot name. */
  snapshot: string;
  /** Number of package updates applied. */
  updates: number;
  /** Post-patch health check. */
  health: HealthCheck;
  /** Whether an automatic rollback to the snapshot was triggered. */
  rolledBack: boolean;
  outcome: Outcome;
  detail: string;
}

export interface PatchReport extends ReportBase {
  capability: "patch-orchestrate";
  /** Maintenance window the run was constrained to (empty = anytime). */
  window: string;
  steps: PatchStep[];
  rolledBack: number;
  patched: number;
}

// ---- DR drill --------------------------------------------------------------

export interface DrStepResult {
  index: number;
  action: string;
  target: string;
  outcome: Outcome;
  detail: string;
  ms: number;
}

export interface DrReport extends ReportBase {
  capability: "dr-drill";
  /** Runbook name from the YAML. */
  runbook: string;
  /** Environment the drill ran against (never production). */
  environment: string;
  /** Measured Recovery Time Objective, seconds. */
  rtoSec: number;
  /** Recovery Point Objective (age of the recovery data), seconds. */
  rpoSec: number;
  steps: DrStepResult[];
}

/** Any resilience report. */
export type ResilienceReport = BackupVerifyReport | PatchReport | DrReport;

/** Compact last-run summary for dashboards / the TUI. */
export interface RunSummary {
  capability: Capability;
  title: string;
  outcome: Outcome;
  finishedAt: string;
  /** Headline metric, e.g. "RTO 4m 12s" or "8/9 checks". */
  metric: string;
  /** Short key fingerprint of the signature, or "" if unsigned. */
  signedBy: string;
  id: string;
}
