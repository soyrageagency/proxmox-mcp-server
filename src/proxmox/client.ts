/**
 * Proxmox VE API client.
 *
 * A small, typed wrapper around the Proxmox VE REST API (`/api2/json`). It
 * supports both API-token auth (recommended) and username/password ticket
 * auth, controls TLS verification (Proxmox ships self-signed certs), applies
 * the optional guest allowlist and exposes the helpers the tools build on.
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { Agent } from "undici";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";

/** A guest (QEMU VM or LXC container) as seen in cluster resources. */
export interface Guest {
  type: "qemu" | "lxc";
  vmid: number;
  name: string;
  node: string;
  status: string;
  cpu: number; // 0..1 ratio
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  template: boolean;
}

/** A cluster node summary. */
export interface NodeSummary {
  node: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  uptime: number;
}

/** Raised when a guest is excluded by the allowlist. */
export class GuestNotAllowedError extends Error {
  constructor(ref: string) {
    super(`Guest "${ref}" is not covered by PROXMOX_MCP_ALLOWLIST and cannot be accessed.`);
    this.name = "GuestNotAllowedError";
  }
}

/** Raised when a referenced guest does not exist. */
export class GuestNotFoundError extends Error {
  constructor(ref: string) {
    super(`No VM or container matches "${ref}".`);
    this.name = "GuestNotFoundError";
  }
}

interface RawResource {
  type: string;
  vmid?: number;
  name?: string;
  node?: string;
  status?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  template?: number;
}

/** Application-facing Proxmox client. One instance is shared across tools. */
export class ProxmoxClient {
  private readonly log: Logger;
  private readonly agent: Agent;
  private readonly allowlist: readonly string[];
  private ticket: { cookie: string; csrf: string } | null = null;

  constructor(
    private readonly config: AppConfig,
    logger: Logger,
  ) {
    this.log = logger.child("api");
    this.allowlist = config.allowlist;
    // Control TLS verification (Proxmox nodes are usually self-signed).
    this.agent = new Agent({ connect: { rejectUnauthorized: config.verifyTls } });
  }

  /** True when using username/password ticket auth (vs. an API token). */
  private get usingTicket(): boolean {
    return !this.config.tokenSecret && Boolean(this.config.user && this.config.password);
  }

  /** Verify connectivity/credentials by hitting /version. */
  async ping(): Promise<void> {
    await this.get("/version");
    this.log.debug("Proxmox API reachable");
  }

  // ---- Low-level request layer ------------------------------------------

  private async authHeaders(method: string): Promise<Record<string, string>> {
    if (this.config.tokenSecret) {
      return { Authorization: `PVEAPIToken=${this.config.tokenId}=${this.config.tokenSecret}` };
    }
    if (this.usingTicket) {
      if (!this.ticket) await this.login();
      const headers: Record<string, string> = { Cookie: `PVEAuthCookie=${this.ticket!.cookie}` };
      if (method !== "GET") headers.CSRFPreventionToken = this.ticket!.csrf;
      return headers;
    }
    throw new Error(
      "No Proxmox credentials configured. Set PROXMOX_TOKEN_ID + PROXMOX_TOKEN_SECRET (recommended) or PROXMOX_USER + PROXMOX_PASSWORD.",
    );
  }

  /** Acquire a login ticket (username/password auth). */
  private async login(): Promise<void> {
    const body = new URLSearchParams({
      username: this.config.user,
      password: this.config.password,
    }).toString();
    const res = await this.fetch("POST", "/access/ticket", body, {
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Proxmox login failed (${res.status}): ${text.slice(0, 200)}`);
    const data = (JSON.parse(text).data ?? {}) as { ticket?: string; CSRFPreventionToken?: string };
    if (!data.ticket) throw new Error("Proxmox login did not return a ticket.");
    this.ticket = { cookie: data.ticket, csrf: data.CSRFPreventionToken ?? "" };
    this.log.debug("Acquired Proxmox login ticket");
  }

  private fetch(
    method: string,
    path: string,
    body?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const url = `${this.config.host}/api2/json${path}`;
    const options = {
      method,
      headers: extraHeaders,
      body,
      dispatcher: this.agent,
    };
    return fetch(url, options as unknown as RequestInit);
  }

  /** Perform an authenticated request and return the `data` payload. */
  private async request<T>(
    method: string,
    path: string,
    params?: Record<string, string | number>,
  ): Promise<T> {
    if (!this.config.host) throw new Error("PROXMOX_HOST is not configured.");
    const headers = await this.authHeaders(method);
    let body: string | undefined;
    if (params && method !== "GET") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(
        Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      ).toString();
    }

    let res = await this.fetch(method, path, body, headers);
    if (res.status === 401 && this.usingTicket) {
      // Ticket may have expired — re-authenticate once and retry.
      this.ticket = null;
      const retryHeaders = await this.authHeaders(method);
      if (body) retryHeaders["Content-Type"] = "application/x-www-form-urlencoded";
      res = await this.fetch(method, path, body, retryHeaders);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Proxmox API ${res.status} on ${path}: ${text.slice(0, 300)}`);
    }
    const json = text ? (JSON.parse(text) as { data?: T }) : { data: undefined };
    return json.data as T;
  }

  /** GET helper. */
  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /** POST helper (form-encoded params). */
  post<T = unknown>(path: string, params?: Record<string, string | number>): Promise<T> {
    return this.request<T>("POST", path, params);
  }

  /** DELETE helper. */
  del<T = unknown>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  // ---- High-level helpers ------------------------------------------------

  /** Proxmox version info. */
  version(): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>("/version");
  }

  /** All cluster nodes with load summary. */
  async nodes(): Promise<NodeSummary[]> {
    const list = await this.get<Array<Record<string, unknown>>>("/nodes");
    return (list ?? []).map((n) => ({
      node: String(n.node ?? ""),
      status: String(n.status ?? "unknown"),
      cpu: Number(n.cpu ?? 0),
      maxcpu: Number(n.maxcpu ?? 0),
      mem: Number(n.mem ?? 0),
      maxmem: Number(n.maxmem ?? 0),
      uptime: Number(n.uptime ?? 0),
    }));
  }

  /** Raw cluster resources (optionally filtered by type). */
  clusterResources(type?: string): Promise<RawResource[]> {
    const q = type ? `?type=${encodeURIComponent(type)}` : "";
    return this.get<RawResource[]>(`/cluster/resources${q}`);
  }

  /** Cluster status (quorum, members). */
  clusterStatus(): Promise<Array<Record<string, unknown>>> {
    return this.get<Array<Record<string, unknown>>>("/cluster/status");
  }

  /** All guests (QEMU + LXC), honouring the allowlist. */
  async guests(): Promise<Guest[]> {
    const resources = await this.clusterResources("vm");
    const guests = (resources ?? [])
      .filter((r) => r.type === "qemu" || r.type === "lxc")
      .map((r): Guest => ({
        type: r.type as "qemu" | "lxc",
        vmid: Number(r.vmid ?? 0),
        name: String(r.name ?? `vm-${r.vmid}`),
        node: String(r.node ?? ""),
        status: String(r.status ?? "unknown"),
        cpu: Number(r.cpu ?? 0),
        maxcpu: Number(r.maxcpu ?? 0),
        mem: Number(r.mem ?? 0),
        maxmem: Number(r.maxmem ?? 0),
        disk: Number(r.disk ?? 0),
        maxdisk: Number(r.maxdisk ?? 0),
        uptime: Number(r.uptime ?? 0),
        template: Boolean(r.template),
      }));
    if (this.allowlist.length === 0) return guests;
    return guests.filter((g) => this.isAllowed(g));
  }

  /** Whether a guest is permitted by the allowlist (by VMID or name). */
  isAllowed(guest: Guest): boolean {
    if (this.allowlist.length === 0) return true;
    return this.allowlist.some((entry) => entry === String(guest.vmid) || entry === guest.name);
  }

  /**
   * Resolve a reference (VMID or name) to a guest, enforcing the allowlist.
   * Returns the guest including its node — required for every guest API call.
   */
  async resolveGuest(reference: string): Promise<Guest> {
    const ref = reference.trim();
    const all = await this.guestsUnfiltered();
    const match = all.find((g) => String(g.vmid) === ref || g.name === ref);
    if (!match) throw new GuestNotFoundError(reference);
    if (!this.isAllowed(match)) throw new GuestNotAllowedError(reference);
    return match;
  }

  /** Internal: guests without allowlist filtering (for resolution/errors). */
  private async guestsUnfiltered(): Promise<Guest[]> {
    const resources = await this.clusterResources("vm");
    return (resources ?? [])
      .filter((r) => r.type === "qemu" || r.type === "lxc")
      .map((r): Guest => ({
        type: r.type as "qemu" | "lxc",
        vmid: Number(r.vmid ?? 0),
        name: String(r.name ?? `vm-${r.vmid}`),
        node: String(r.node ?? ""),
        status: String(r.status ?? "unknown"),
        cpu: Number(r.cpu ?? 0),
        maxcpu: Number(r.maxcpu ?? 0),
        mem: Number(r.mem ?? 0),
        maxmem: Number(r.maxmem ?? 0),
        disk: Number(r.disk ?? 0),
        maxdisk: Number(r.maxdisk ?? 0),
        uptime: Number(r.uptime ?? 0),
        template: Boolean(r.template),
      }));
  }

  /** Base API path for a guest, e.g. /nodes/pve/qemu/100. */
  guestBase(guest: Guest): string {
    return `/nodes/${guest.node}/${guest.type}/${guest.vmid}`;
  }

  /** Current runtime status of a guest. */
  guestStatus(guest: Guest): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(`${this.guestBase(guest)}/status/current`);
  }

  /** Full configuration of a guest. */
  guestConfig(guest: Guest): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(`${this.guestBase(guest)}/config`);
  }

  /** Storage available on a node. */
  storage(node: string): Promise<Array<Record<string, unknown>>> {
    return this.get<Array<Record<string, unknown>>>(`/nodes/${node}/storage`);
  }

  /** Recent tasks on a node. */
  tasks(node: string, limit = 25): Promise<Array<Record<string, unknown>>> {
    return this.get<Array<Record<string, unknown>>>(`/nodes/${node}/tasks?limit=${limit}`);
  }

  /** Snapshots of a guest. */
  snapshots(guest: Guest): Promise<Array<Record<string, unknown>>> {
    return this.get<Array<Record<string, unknown>>>(`${this.guestBase(guest)}/snapshot`);
  }
}
