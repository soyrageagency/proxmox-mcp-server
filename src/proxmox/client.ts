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
  private readonly demo: boolean;
  private ticket: { cookie: string; csrf: string } | null = null;

  constructor(
    private readonly config: AppConfig,
    logger: Logger,
  ) {
    this.log = logger.child("api");
    this.allowlist = config.allowlist;
    this.demo = config.demo;
    if (this.demo) this.log.info("Running in DEMO mode (fabricated cluster data).");
    // Control TLS verification (Proxmox nodes are usually self-signed).
    this.agent = new Agent({ connect: { rejectUnauthorized: config.verifyTls } });
  }

  /** Whether the client is serving fabricated demo data. */
  get isDemo(): boolean {
    return this.demo;
  }

  /** True when using username/password ticket auth (vs. an API token). */
  private get usingTicket(): boolean {
    return !this.config.tokenSecret && Boolean(this.config.user && this.config.password);
  }

  /** Verify connectivity/credentials by hitting /version. */
  async ping(): Promise<void> {
    if (this.demo) return;
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
      "Proxmox is not set up yet. Ask the user to run the guided installer (`npm run setup`) " +
        "and paste their Proxmox host + API token, or to try demo mode (PROXMOX_MCP_DEMO=true) " +
        "to explore without a real cluster.",
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
    if (!this.config.host) {
      throw new Error(
        "Proxmox is not set up yet (no host). Ask the user to run the guided installer " +
          "(`npm run setup`) and paste their Proxmox host + API token, or to try demo mode " +
          "(PROXMOX_MCP_DEMO=true).",
      );
    }
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
    if (this.demo) {
      this.log.info(`(demo) POST ${path}`);
      return Promise.resolve(`UPID:demo:00000000:${path}` as unknown as T);
    }
    return this.request<T>("POST", path, params);
  }

  /** DELETE helper. */
  del<T = unknown>(path: string): Promise<T> {
    if (this.demo) {
      this.log.info(`(demo) DELETE ${path}`);
      return Promise.resolve({} as T);
    }
    return this.request<T>("DELETE", path);
  }

  // ---- High-level helpers ------------------------------------------------

  /** Proxmox version info. */
  version(): Promise<Record<string, unknown>> {
    if (this.demo) return Promise.resolve({ version: "8.2.4", release: "8.2", repoid: "demo" });
    return this.get<Record<string, unknown>>("/version");
  }

  /** Detailed status of a single node. */
  nodeStatus(node: string): Promise<Record<string, unknown>> {
    if (this.demo) return Promise.resolve(demoNodeStatus(node));
    return this.get<Record<string, unknown>>(`/nodes/${node}/status`);
  }

  /** All cluster nodes with load summary. */
  async nodes(): Promise<NodeSummary[]> {
    if (this.demo) return demoNodes();
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
    if (this.demo) {
      const all = demoResources();
      return Promise.resolve(
        type === "vm" ? all.filter((r) => r.type === "qemu" || r.type === "lxc")
          : type ? all.filter((r) => r.type === type)
          : all,
      );
    }
    const q = type ? `?type=${encodeURIComponent(type)}` : "";
    return this.get<RawResource[]>(`/cluster/resources${q}`);
  }

  /** Cluster status (quorum, members). */
  clusterStatus(): Promise<Array<Record<string, unknown>>> {
    if (this.demo) return Promise.resolve(demoClusterStatus());
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
    if (this.demo) return Promise.resolve(demoGuestStatus(guest));
    return this.get<Record<string, unknown>>(`${this.guestBase(guest)}/status/current`);
  }

  /** Full configuration of a guest. */
  guestConfig(guest: Guest): Promise<Record<string, unknown>> {
    if (this.demo) return Promise.resolve(demoGuestConfig(guest));
    return this.get<Record<string, unknown>>(`${this.guestBase(guest)}/config`);
  }

  /** Storage available on a node. */
  storage(node: string): Promise<Array<Record<string, unknown>>> {
    if (this.demo) return Promise.resolve(demoStorage());
    return this.get<Array<Record<string, unknown>>>(`/nodes/${node}/storage`);
  }

  /** Recent tasks on a node. */
  tasks(node: string, limit = 25): Promise<Array<Record<string, unknown>>> {
    if (this.demo) return Promise.resolve(demoTasks().slice(0, limit));
    return this.get<Array<Record<string, unknown>>>(`/nodes/${node}/tasks?limit=${limit}`);
  }

  /** Snapshots of a guest. */
  snapshots(guest: Guest): Promise<Array<Record<string, unknown>>> {
    if (this.demo) return Promise.resolve(demoSnapshots(guest));
    return this.get<Array<Record<string, unknown>>>(`${this.guestBase(guest)}/snapshot`);
  }

  /**
   * Operating-system info for a guest: the configured `ostype` plus, for
   * running QEMU VMs with the guest agent, the detected OS and IP addresses.
   */
  async osInfo(guest: Guest): Promise<Record<string, unknown>> {
    if (this.demo) return demoOsInfo(guest);
    const config = await this.guestConfig(guest);
    const result: Record<string, unknown> = {
      vmid: guest.vmid,
      name: guest.name,
      type: guest.type,
      ostype: config.ostype ?? "unknown",
    };
    if (guest.type === "qemu" && guest.status === "running") {
      // Requires the QEMU guest agent to be installed and enabled.
      try {
        result.agent = await this.get(`${this.guestBase(guest)}/agent/get-osinfo`);
      } catch {
        result.agentNote = "QEMU guest agent not available (install/enable it for live OS info).";
      }
      try {
        result.interfaces = await this.get(`${this.guestBase(guest)}/agent/network-get-interfaces`);
      } catch {
        /* interfaces are best-effort */
      }
    }
    return result;
  }

  /** List the content of a storage (backups, ISOs, templates, disks…). */
  storageContent(node: string, storage: string, content?: string): Promise<Array<Record<string, unknown>>> {
    if (this.demo) return Promise.resolve(demoStorageContent(content));
    const q = content ? `?content=${encodeURIComponent(content)}` : "";
    return this.get<Array<Record<string, unknown>>>(`/nodes/${node}/storage/${storage}/content${q}`);
  }

  /** Storages on a node that can hold backups. */
  async backupStorages(node: string): Promise<string[]> {
    if (this.demo) return ["nas-backups"];
    const s = await this.storage(node);
    return s.filter((x) => String(x.content ?? "").includes("backup")).map((x) => String(x.storage));
  }

  /** Resolve a node name, defaulting to the first cluster node. */
  async resolveNode(node?: string): Promise<string> {
    if (node) return node;
    const nodes = await this.nodes();
    if (nodes.length === 0) throw new Error("No Proxmox nodes found.");
    return nodes[0].node;
  }

  /** Whether the AI copilot is available (demo always simulates it). */
  get aiEnabled(): boolean {
    return this.demo || Boolean(this.config.aiEndpoint);
  }

  /**
   * AI copilot: interpret a natural-language order against the current guests
   * and return a structured intent — either an action to run on a guest, or a
   * plain-language answer. Uses an OpenAI-compatible endpoint when configured;
   * demo mode simulates it with a small rule engine.
   */
  async aiAssist(prompt: string): Promise<AiIntent> {
    const guests = await this.guests();
    if (this.demo || !this.config.aiEndpoint) {
      return demoAi(prompt, guests, this.demo ? "demo-ai" : "unconfigured");
    }
    const roster = guests
      .map((g) => `${g.vmid} ${g.name} (${g.type === "qemu" ? "VM" : "CT"}, ${g.status})`)
      .join("; ");
    const system =
      "You operate a Proxmox VE cluster. Given a user's order in plain language, reply ONLY with a compact JSON object " +
      '{"action":"start|shutdown|stop|reboot|snapshot|none","guest":"<vmid or name, empty if none>","answer":"<short answer if it is a question, else empty>","explanation":"<one short sentence>"}. ' +
      `Available guests: ${roster}. Prefer 'shutdown' over 'stop'. If the request is a question, set action to none and fill 'answer'.`;
    try {
      const url = this.config.aiEndpoint.replace(/\/$/, "") + "/chat/completions";
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.aiKey ? { Authorization: `Bearer ${this.config.aiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.aiModel,
          temperature: 0.1,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (!res.ok) throw new Error(`AI endpoint returned ${res.status}`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const raw = data.choices?.[0]?.message?.content ?? "";
      const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      return {
        action: ["start", "shutdown", "stop", "reboot", "snapshot"].includes(json.action) ? json.action : "none",
        guest: String(json.guest ?? ""),
        answer: String(json.answer ?? ""),
        explanation: String(json.explanation ?? ""),
        source: "ai",
      };
    } catch (err) {
      return { action: "none", guest: "", answer: `AI error: ${(err as Error).message}`, explanation: "", source: "error" };
    }
  }
}

/** A structured AI intent returned by aiAssist. */
export interface AiIntent {
  action: "start" | "shutdown" | "stop" | "reboot" | "snapshot" | "none";
  guest: string;
  answer: string;
  explanation: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Demo data — a believable two-node cluster so the server can be tried without
// a real Proxmox host (PROXMOX_MCP_DEMO=true).
// ---------------------------------------------------------------------------

const GiB = 1024 ** 3;

function demoNodes(): NodeSummary[] {
  return [
    { node: "pve", status: "online", cpu: 0.14, maxcpu: 16, mem: 18 * GiB, maxmem: 64 * GiB, uptime: 1_987_200 },
    { node: "pve2", status: "online", cpu: 0.06, maxcpu: 8, mem: 9 * GiB, maxmem: 32 * GiB, uptime: 1_814_400 },
  ];
}

function demoNodeStatus(node: string): Record<string, unknown> {
  const n = demoNodes().find((x) => x.node === node) ?? demoNodes()[0];
  return {
    uptime: n.uptime,
    cpu: n.cpu,
    loadavg: ["0.42", "0.51", "0.48"],
    memory: { total: n.maxmem, used: n.mem, free: n.maxmem - n.mem },
    swap: { total: 8 * GiB, used: 0.2 * GiB },
    rootfs: { total: 100 * GiB, used: 34 * GiB },
    pveversion: "pve-manager/8.2.4",
    kversion: "Linux 6.8.12-1-pve",
    cpuinfo: { model: "AMD Ryzen 7 5825U", cores: n.maxcpu, sockets: 1 },
  };
}

function demoResources(): RawResource[] {
  const g = (type: "qemu" | "lxc", vmid: number, name: string, node: string, status: string, cpu: number, maxcpu: number, mem: number, maxmem: number, disk: number, maxdisk: number, uptime: number): RawResource =>
    ({ type, vmid, name, node, status, cpu, maxcpu, mem, maxmem, disk, maxdisk, uptime, template: 0 });
  return [
    { type: "node", node: "pve", status: "online", cpu: 0.14, maxcpu: 16, mem: 18 * GiB, maxmem: 64 * GiB },
    { type: "node", node: "pve2", status: "online", cpu: 0.06, maxcpu: 8, mem: 9 * GiB, maxmem: 32 * GiB },
    g("qemu", 100, "web", "pve", "running", 0.031, 4, 1.8 * GiB, 4 * GiB, 12 * GiB, 32 * GiB, 1_987_000),
    g("qemu", 101, "db", "pve", "running", 0.087, 4, 6.2 * GiB, 8 * GiB, 48 * GiB, 120 * GiB, 1_986_000),
    g("qemu", 102, "windows-rdp", "pve2", "stopped", 0, 6, 0, 16 * GiB, 0, 200 * GiB, 0),
    g("lxc", 200, "nginx-proxy", "pve", "running", 0.004, 1, 96 * 1024 * 1024, 512 * 1024 * 1024, 1.2 * GiB, 8 * GiB, 1_980_000),
    g("lxc", 201, "grafana", "pve", "running", 0.012, 2, 240 * 1024 * 1024, 2 * GiB, 3.5 * GiB, 16 * GiB, 1_200_000),
    g("lxc", 202, "pihole", "pve2", "running", 0.002, 1, 64 * 1024 * 1024, 512 * 1024 * 1024, 0.9 * GiB, 8 * GiB, 900_000),
    g("lxc", 203, "backup-runner", "pve2", "stopped", 0, 1, 0, 512 * 1024 * 1024, 0, 8 * GiB, 0),
    { type: "storage", node: "pve", name: "local", status: "available" },
    { type: "storage", node: "pve", name: "local-lvm", status: "available" },
  ];
}

function demoClusterStatus(): Array<Record<string, unknown>> {
  return [
    { type: "cluster", name: "soyrage-lab", nodes: 2, quorate: 1, version: 4 },
    { type: "node", name: "pve", online: 1, local: 1, ip: "10.0.0.11" },
    { type: "node", name: "pve2", online: 1, local: 0, ip: "10.0.0.12" },
  ];
}

function demoGuestStatus(guest: Guest): Record<string, unknown> {
  const running = guest.status === "running";
  return {
    status: guest.status,
    vmid: guest.vmid,
    name: guest.name,
    cpus: guest.maxcpu,
    cpu: guest.cpu,
    mem: guest.mem,
    maxmem: guest.maxmem,
    disk: guest.disk,
    maxdisk: guest.maxdisk,
    uptime: guest.uptime,
    ...(guest.type === "qemu" ? { qmpstatus: guest.status, agent: running ? 1 : 0 } : { type: "lxc" }),
    ha: { managed: 0 },
  };
}

function demoGuestConfig(guest: Guest): Record<string, unknown> {
  if (guest.type === "qemu") {
    return {
      name: guest.name,
      cores: guest.maxcpu,
      sockets: 1,
      memory: Math.round(guest.maxmem / (1024 * 1024)),
      ostype: "l26",
      scsi0: `local-lvm:vm-${guest.vmid}-disk-0,size=${Math.round(guest.maxdisk / GiB)}G`,
      net0: "virtio=DE:AD:BE:EF:00:0A,bridge=vmbr0",
      boot: "order=scsi0",
      agent: 1,
    };
  }
  return {
    hostname: guest.name,
    cores: guest.maxcpu,
    memory: Math.round(guest.maxmem / (1024 * 1024)),
    rootfs: `local-lvm:subvol-${guest.vmid}-disk-0,size=${Math.round(guest.maxdisk / GiB)}G`,
    net0: "name=eth0,bridge=vmbr0,ip=dhcp",
    ostype: "debian",
    unprivileged: 1,
  };
}

function demoStorage(): Array<Record<string, unknown>> {
  return [
    { storage: "local", type: "dir", content: "iso,vztmpl,backup", active: 1, total: 100 * GiB, used: 34 * GiB, avail: 66 * GiB },
    { storage: "local-lvm", type: "lvmthin", content: "images,rootdir", active: 1, total: 400 * GiB, used: 176 * GiB, avail: 224 * GiB },
    { storage: "nas-backups", type: "nfs", content: "backup", active: 1, total: 4000 * GiB, used: 1200 * GiB, avail: 2800 * GiB },
  ];
}

function demoTasks(): Array<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000);
  return [
    { type: "vzdump", id: "101", user: "root@pam", status: "OK", starttime: now - 3600, endtime: now - 3400 },
    { type: "qmstart", id: "100", user: "root@pam!mcp", status: "OK", starttime: now - 7200, endtime: now - 7199 },
    { type: "vzsnapshot", id: "201", user: "root@pam", status: "OK", starttime: now - 10800, endtime: now - 10797 },
    { type: "vncproxy", id: "100", user: "admin@pve", status: "OK", starttime: now - 14400, endtime: now - 14395 },
    { type: "vzdump", id: "200", user: "root@pam", status: "OK", starttime: now - 90000, endtime: now - 89700 },
  ];
}

const DEMO_OS: Record<string, string> = {
  web: "Debian GNU/Linux 12 (bookworm)",
  db: "Debian GNU/Linux 12 (bookworm)",
  "windows-rdp": "Windows 11 Pro",
  "nginx-proxy": "Alpine Linux v3.20",
  grafana: "Ubuntu 24.04 LTS",
  pihole: "Debian GNU/Linux 12 (bookworm)",
  "backup-runner": "Debian GNU/Linux 12 (bookworm)",
};

function demoOsInfo(guest: Guest): Record<string, unknown> {
  const pretty = DEMO_OS[guest.name] ?? "Debian GNU/Linux 12 (bookworm)";
  const isWin = /windows/i.test(pretty);
  const ostype = guest.type === "lxc" ? "debian" : isWin ? "win11" : "l26";
  const info: Record<string, unknown> = { vmid: guest.vmid, name: guest.name, type: guest.type, ostype };
  if (guest.status === "running") {
    info.agent = {
      result: {
        name: isWin ? "Microsoft Windows" : pretty.split(" ")[0],
        "pretty-name": pretty,
        "kernel-release": isWin ? "10.0.22631" : "6.8.12-1-pve",
        machine: "x86_64",
      },
    };
    info.interfaces = {
      result: [
        { name: guest.type === "lxc" ? "eth0" : isWin ? "Ethernet" : "ens18", "ip-addresses": [{ "ip-address": `10.0.0.${guest.vmid}`, "ip-address-type": "ipv4" }] },
      ],
    };
  } else {
    info.agentNote = "Guest is not running.";
  }
  return info;
}

/** Rule-based AI copilot used in demo mode (and as an unconfigured fallback). */
function demoAi(prompt: string, guests: Guest[], source: string): AiIntent {
  const p = prompt.toLowerCase();
  const g = guests.find((x) => p.includes(x.name.toLowerCase()) || new RegExp(`\\b${x.vmid}\\b`).test(p));

  // Questions first.
  if (/\b(which|what|list|show|how many|down|running|stopped|status|using|ram|memory|cpu)\b/.test(p) && !/\b(restart|reboot|stop|start|shutdown|snapshot)\b/.test(p)) {
    if (/\b(down|stopped|off)\b/.test(p)) {
      const down = guests.filter((x) => x.status !== "running");
      const ans = down.length ? down.map((x) => `${x.name} (VMID ${x.vmid})`).join(", ") : "none — everything is running.";
      return { action: "none", guest: "", answer: `Stopped guests: ${ans}`, explanation: "", source };
    }
    if (/\b(ram|memory)\b/.test(p) && g) {
      return { action: "none", guest: g.name, answer: `${g.name} (VMID ${g.vmid}) is using ${(g.mem / 1024 ** 3).toFixed(1)} GB of ${(g.maxmem / 1024 ** 3).toFixed(1)} GB RAM.`, explanation: "", source };
    }
    const running = guests.filter((x) => x.status === "running");
    return { action: "none", guest: "", answer: `${running.length}/${guests.length} guests running: ${running.map((x) => x.name).join(", ")}.`, explanation: "", source };
  }

  // Actions.
  let action: AiIntent["action"] = "none";
  if (/\b(reboot|restart)\b/.test(p)) action = "reboot";
  else if (/\b(stop|kill|force)\b/.test(p)) action = "stop";
  else if (/\b(shutdown|shut down|turn off|power off)\b/.test(p)) action = "shutdown";
  else if (/\b(start|boot|power on|turn on)\b/.test(p)) action = "start";
  else if (/\bsnapshot\b/.test(p)) action = "snapshot";

  if (action !== "none" && g) {
    return { action, guest: g.name, answer: "", explanation: `Interpreted "${prompt}" as ${action} ${g.name}.${source === "unconfigured" ? " (rule-based — set PROXMOX_MCP_AI_ENDPOINT for a real model)" : ""}`, source };
  }
  if (action !== "none" && !g) {
    return { action: "none", guest: "", answer: `Which guest should I ${action}? Try e.g. "${action} db".`, explanation: "", source };
  }
  return { action: "none", guest: "", answer: `I didn't catch an action. Try "restart db", "shutdown 200", or ask "which VMs are down?".`, explanation: "", source };
}

function demoStorageContent(content?: string): Array<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000);
  const backups = [
    { volid: "nas-backups:backup/vzdump-qemu-101-2026_07_16-03_00_04.vma.zst", content: "backup", format: "vma.zst", size: 21_495_808_000, vmid: 101, ctime: now - 3600 },
    { volid: "nas-backups:backup/vzdump-lxc-201-2026_07_16-03_02_10.tar.zst", content: "backup", format: "tar.zst", size: 3_650_000_000, vmid: 201, ctime: now - 3300 },
    { volid: "nas-backups:backup/vzdump-qemu-100-2026_07_15-03_00_00.vma.zst", content: "backup", format: "vma.zst", size: 12_800_000_000, vmid: 100, ctime: now - 90000 },
  ];
  const templates = [
    { volid: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst", content: "vztmpl", size: 130_000_000 },
    { volid: "local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst", content: "vztmpl", size: 145_000_000 },
    { volid: "local:vztmpl/alpine-3.20-default_20240908_amd64.tar.xz", content: "vztmpl", size: 3_400_000 },
  ];
  const isos = [
    { volid: "local:iso/debian-12.7.0-amd64-netinst.iso", content: "iso", size: 660_000_000 },
    { volid: "local:iso/ubuntu-24.04.1-live-server-amd64.iso", content: "iso", size: 2_800_000_000 },
  ];
  if (content === "backup") return backups;
  if (content === "vztmpl") return templates;
  if (content === "iso") return isos;
  return [...backups, ...templates, ...isos];
}

function demoSnapshots(guest: Guest): Array<Record<string, unknown>> {
  if (guest.vmid === 101) {
    return [
      { name: "pre-upgrade", parent: "", description: "before PostgreSQL 16 upgrade" },
      { name: "nightly", parent: "pre-upgrade", description: "automated nightly" },
      { name: "current", parent: "nightly", description: "You are here!" },
    ];
  }
  return [{ name: "current", parent: "", description: "You are here!" }];
}
