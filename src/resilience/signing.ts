/**
 * Evidence signing (Ed25519, zero external dependencies).
 *
 * Compliance evidence is only useful if it can be trusted. Every resilience
 * report is signed with an Ed25519 key so an auditor can verify — offline, with
 * only the bundled public key — that the report was produced by this system on
 * the stated date and has not been altered since.
 *
 * The private key lives on disk (generated on first use, or supplied via
 * PROXMOX_MCP_SIGNING_KEY). Reports embed the public key + its fingerprint, so
 * verification never needs the secret.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import {
  createHash,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPublicKey,
  createPrivateKey,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Signature } from "./types.js";

/** Deterministically serialise a value so the digest is stable across runs. */
export function canonical(value: unknown): string {
  const seen = new WeakSet();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return undefined;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, val]) => [k, walk(val)]));
  };
  return JSON.stringify(walk(value));
}

/** SHA-256 hex digest of a string. */
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Load the signing key from `keyPath`, generating and persisting a fresh
 * Ed25519 keypair there on first use. Returns both key objects.
 */
export function loadSigningKey(keyPath: string): { priv: KeyObject; pub: KeyObject } {
  if (existsSync(keyPath)) {
    const pem = readFileSync(keyPath, "utf8");
    const priv = createPrivateKey(pem);
    return { priv, pub: createPublicKey(priv) };
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, pem, { mode: 0o600 });
  return { priv: privateKey, pub: publicKey };
}

/** Public-key fingerprint: SHA-256 of the DER SPKI, hex, colon-grouped short form. */
export function fingerprint(pub: KeyObject): string {
  const der = pub.export({ type: "spki", format: "der" }) as Buffer;
  const hex = createHash("sha256").update(der).digest("hex");
  return hex.slice(0, 32);
}

/**
 * Sign a report payload. The signature covers the SHA-256 digest of the
 * canonical (key-sorted) JSON of `payload` — i.e. the whole report minus the
 * signature block itself.
 */
export function signPayload(payload: unknown, keyPath: string, signedAt: string): Signature {
  const { priv, pub } = loadSigningKey(keyPath);
  const digest = sha256(canonical(payload));
  const signature = edSign(null, Buffer.from(digest, "hex"), priv).toString("base64");
  return {
    algorithm: "ed25519",
    digest,
    signature,
    keyFingerprint: fingerprint(pub),
    publicKeyPem: (pub.export({ type: "spki", format: "pem" }) as string).trim(),
    signedAt,
  };
}

/**
 * Verify a report's signature against its embedded public key. Returns true
 * only if the digest matches the payload AND the signature matches the digest.
 */
export function verifySignature(payload: unknown, sig: Signature): boolean {
  try {
    const digest = sha256(canonical(payload));
    if (digest !== sig.digest) return false;
    const pub = createPublicKey(sig.publicKeyPem);
    return edVerify(null, Buffer.from(digest, "hex"), pub, Buffer.from(sig.signature, "base64"));
  } catch {
    return false;
  }
}
