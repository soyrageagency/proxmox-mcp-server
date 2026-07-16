/**
 * Terminal UI application.
 *
 * A creative, lazydocker-style TUI for a Proxmox VE cluster: a full-screen
 * dashboard with a live guest list (VMs + LXC), per-guest CPU/memory gauges, a
 * details/snapshots pane and one-key lifecycle actions — wrapped in a SoyRage
 * Agency welcome. Hand-rolled ANSI (no curses library, zero UI dependencies).
 *
 * Part of Proxmox MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { BRAND, ASCII_BANNER } from "../branding.js";
import type { AppConfig } from "../config.js";
import type { ProxmoxClient, Guest, NodeSummary } from "../proxmox/client.js";
import { bar, center, color, ctl, padEnd, padStart, truncate } from "./ansi.js";
import { drawBox } from "./box.js";

/** Humanise bytes compactly. */
function bytes(n?: number): string {
  if (!n) return "0B";
  const u = ["B", "K", "M", "G", "T"];
  const e = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** e).toFixed(e === 0 ? 0 : 1)}${u[e]}`;
}

/** Uptime seconds → "3d 4h". */
function upt(s: number): string {
  if (!s || s <= 0) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

type Mode = "splash" | "main";

/** The interactive terminal application. */
export class TuiApp {
  private mode: Mode = "splash";
  private nodes: NodeSummary[] = [];
  private guests: Guest[] = [];
  private selected = 0;
  private showSnaps = false;
  private snaps: Array<Record<string, unknown>> = [];
  private selOs = "";
  private status = "";
  private timer: NodeJS.Timeout | null = null;
  private refreshing = false;

  constructor(
    private readonly client: ProxmoxClient,
    private readonly config: AppConfig,
    private readonly out = process.stdout,
    private readonly inp = process.stdin,
  ) {}

  async start(): Promise<void> {
    this.out.write(ctl.enterAlt + ctl.hideCursor + ctl.clear);
    this.setupInput();
    this.out.on("resize", () => this.render());
    this.renderSplash();
  }

  // ---- Input --------------------------------------------------------------

  private setupInput(): void {
    if (this.inp.isTTY) this.inp.setRawMode(true);
    this.inp.resume();
    this.inp.setEncoding("utf8");
    this.inp.on("data", (key: string) => this.onKey(key));
  }

  private onKey(key: string): void {
    if (key === "\x03" || key === "\x04") return void this.quit();
    if (this.mode === "splash") return void this.enterMain();

    switch (key) {
      case "q":
        return void this.quit();
      case "\x1b[A":
      case "k":
        this.move(-1);
        break;
      case "\x1b[B":
      case "j":
        this.move(1);
        break;
      case "r":
        this.status = "Refreshing…";
        void this.refresh();
        break;
      case "s":
        this.showSnaps = !this.showSnaps;
        if (this.showSnaps) void this.loadSnaps();
        else this.render();
        break;
      case "S":
        void this.action("start");
        break;
      case "d":
        void this.action("shutdown");
        break;
      case "x":
        void this.action("stop");
        break;
      case "b":
        void this.action("reboot");
        break;
      default:
        break;
    }
  }

  private move(delta: number): void {
    if (this.guests.length === 0) return;
    this.selected = (this.selected + delta + this.guests.length) % this.guests.length;
    this.showSnaps = false;
    this.selOs = "";
    this.render();
    void this.updateSelOs();
  }

  /** Resolve the OS of the selected guest (best-effort). No side effects. */
  private async fetchSelOs(): Promise<void> {
    const g = this.current();
    if (!g) {
      this.selOs = "";
      return;
    }
    try {
      const info = await this.client.osInfo(g);
      const agent = (info.agent as { result?: Record<string, unknown> } | undefined)?.result;
      this.selOs = String(agent?.["pretty-name"] ?? agent?.name ?? info.ostype ?? "");
    } catch {
      this.selOs = "";
    }
  }

  /** Fetch the selected guest's OS and re-render (interactive use only). */
  private async updateSelOs(): Promise<void> {
    await this.fetchSelOs();
    this.render();
  }

  private current(): Guest | undefined {
    return this.guests[this.selected];
  }

  // ---- Lifecycle ----------------------------------------------------------

  private async enterMain(): Promise<void> {
    this.mode = "main";
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), 5000);
  }

  private async action(kind: "start" | "shutdown" | "stop" | "reboot"): Promise<void> {
    const g = this.current();
    if (!g) return;
    if (this.config.readOnly) {
      this.status = color.yellow("Read-only mode — actions are disabled.");
      this.render();
      return;
    }
    try {
      this.status = `${kind} ${g.name} (VMID ${g.vmid})…`;
      this.render();
      await this.client.post(`${this.client.guestBase(g)}/status/${kind}`);
      this.status = color.green(`✓ ${kind} requested for ${g.name}`);
      await this.refresh();
    } catch (err) {
      this.status = color.red(`✗ ${(err as Error).message}`);
      this.render();
    }
  }

  private async loadSnaps(): Promise<void> {
    const g = this.current();
    if (!g) return;
    this.snaps = [{ name: "Loading…" }];
    this.render();
    try {
      this.snaps = await this.client.snapshots(g);
    } catch (err) {
      this.snaps = [{ name: `Error: ${(err as Error).message}` }];
    }
    this.render();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const [nodes, guests] = await Promise.all([this.client.nodes(), this.client.guests()]);
      this.nodes = nodes;
      this.guests = guests.sort((a, b) => a.vmid - b.vmid);
      if (this.selected >= this.guests.length) this.selected = 0;
      if (this.showSnaps) await this.loadSnaps();
      else this.render();
      void this.updateSelOs();
    } catch (err) {
      this.status = color.red(`Error: ${(err as Error).message}`);
      this.render();
    } finally {
      this.refreshing = false;
    }
  }

  private quit(): void {
    if (this.timer) clearInterval(this.timer);
    this.out.write(ctl.showCursor + ctl.exitAlt);
    this.out.write(
      `\n  Thanks for using ${color.accent(BRAND.product)} by ${color.bold(BRAND.author)} — ${color.brightBlue(BRAND.url)}\n` +
        `  ${color.yellow("★")} If it helped you, please leave a star. See you soon!\n\n`,
    );
    process.exit(0);
  }

  // ---- Rendering ----------------------------------------------------------

  private cols(): number {
    return this.out.columns && this.out.columns > 20 ? this.out.columns : 100;
  }
  private rows(): number {
    return this.out.rows && this.out.rows > 10 ? this.out.rows : 30;
  }

  private paint(lines: string[]): void {
    const cols = this.cols();
    let frame = ctl.home;
    for (let i = 0; i < lines.length; i++) {
      frame += truncate(lines[i], cols) + ctl.clearLine;
      if (i < lines.length - 1) frame += "\n";
    }
    frame += ctl.clearBelow;
    this.out.write(frame);
  }

  /** Build the welcome-splash lines (also used by `--splash`). */
  splashLines(cols = this.cols(), rows = this.rows()): string[] {
    const banner = ASCII_BANNER.split("\n");
    const block = [
      ...banner.map((l) => color.accent(l)),
      "",
      center(color.bold(`Welcome to ${BRAND.product}`), cols),
      center(color.gray(`by ${BRAND.author} · ${BRAND.url}`), cols),
      "",
      center("Thank you for using our repository.", cols),
      center(`${color.yellow("★")} If it's useful, please leave a ${color.yellow("star")} and share it.`, cols),
      center(`${color.gray("Support the project:")} ${color.brightBlue(BRAND.donate)}`, cols),
      "",
      center(color.dim("Press any key to launch the dashboard…"), cols),
    ];
    const top = Math.max(1, Math.floor((rows - block.length) / 2));
    return [...Array(top).fill(""), ...block.map((l) => center(l, cols))];
  }

  private renderSplash(): void {
    this.paint(this.splashLines());
  }

  /** Render one static main frame to a string (for `--frame`). */
  async frame(cols = 100, rows = 30): Promise<string> {
    this.mode = "main";
    const [nodes, guests] = await Promise.all([this.client.nodes(), this.client.guests()]);
    this.nodes = nodes;
    this.guests = guests.sort((a, b) => a.vmid - b.vmid);
    await this.fetchSelOs(); // no render side-effect (keeps --frame output clean)
    return this.buildMainLines(cols, rows).join("\n");
  }

  private render(): void {
    if (this.mode !== "main") return;
    this.paint(this.buildMainLines(this.cols(), this.rows()));
  }

  private buildMainLines(cols: number, rows: number): string[] {
    const lines: string[] = [];
    lines.push(this.headerLine(cols));
    lines.push(this.resourceLine());

    const bodyHeight = Math.max(6, rows - 5);
    const leftW = Math.max(38, Math.floor(cols * 0.46));
    const rightW = cols - leftW - 1;

    const left = drawBox(
      `Guests (${this.guests.length})`,
      this.guestRows(leftW - 4, bodyHeight - 2),
      leftW,
      bodyHeight,
    );
    const right = drawBox(
      this.showSnaps ? `Snapshots · ${this.current()?.name ?? ""}` : "Details",
      this.showSnaps ? this.snapRows(rightW - 4, bodyHeight - 2) : this.detailRows(rightW - 4, bodyHeight - 2),
      rightW,
      bodyHeight,
    );

    for (let i = 0; i < bodyHeight; i++) lines.push(`${left[i] ?? ""} ${right[i] ?? ""}`);
    lines.push(this.footerKeys(cols));
    lines.push(this.footerBrand(cols));
    return lines;
  }

  private headerLine(cols: number): string {
    const brand = `${color.accent(color.bold("SOYRAGE"))} ${color.gray("▸")} ${color.bold("Proxmox TUI")}`;
    const badges: string[] = [];
    if (this.client.isDemo) badges.push(color.yellow(" DEMO "));
    if (this.config.readOnly) badges.push(color.brightBlue(" READ-ONLY "));
    const online = this.nodes.filter((n) => n.status === "online").length;
    const right = `${color.gray("Nodes")} ${online}/${this.nodes.length} online`;
    const rightAll = `${badges.join(" ")}  ${right}`;
    const gap = Math.max(1, cols - 1 - stripLen(brand) - stripLen(rightAll) - 1);
    return ` ${brand}${" ".repeat(gap)}${rightAll}`;
  }

  private resourceLine(): string {
    if (this.nodes.length === 0) return "";
    const cpu = this.nodes.reduce((s, n) => s + n.cpu, 0) / this.nodes.length;
    const mem = this.nodes.reduce((s, n) => s + n.mem, 0);
    const maxmem = this.nodes.reduce((s, n) => s + n.maxmem, 0);
    const memPct = maxmem ? (mem / maxmem) * 100 : 0;
    const running = this.guests.filter((g) => g.status === "running").length;
    const seg = [
      `${color.gray("CPU")} ${bar(cpu * 100, 14)} ${padStart((cpu * 100).toFixed(1) + "%", 6)}`,
      `${color.gray("MEM")} ${bar(memPct, 14)} ${padStart(bytes(mem), 7)}/${bytes(maxmem)}`,
      `${color.gray("Guests")} ${running}/${this.guests.length} running`,
    ];
    return " " + seg.join(color.dim("   "));
  }

  private guestRows(width: number, height: number): string[] {
    const rows: string[] = [];
    for (let i = 0; i < this.guests.length && i < height; i++) {
      const g = this.guests[i];
      const dot =
        g.status === "running" ? color.green("●") : g.status === "stopped" ? color.red("●") : color.yellow("●");
      const kind = g.type === "qemu" ? color.brightCyan("VM") : color.magenta("CT");
      const cpu = g.status === "running" ? `${(g.cpu * 100).toFixed(1)}%` : "—";
      const mem = g.status === "running" ? bytes(g.mem) : "—";
      const name = padEnd(`${String(g.vmid).padEnd(4)} ${kind} ${g.name}`, Math.max(10, width - 16));
      let line = `${dot} ${name} ${padStart(cpu, 6)} ${padStart(mem, 6)}`;
      if (i === this.selected) line = color.bgAccent(padEnd(line, width));
      rows.push(line);
    }
    if (rows.length === 0) rows.push(color.gray("No guests. (Try PROXMOX_MCP_DEMO=true)"));
    return rows;
  }

  private detailRows(width: number, height: number): string[] {
    const g = this.current();
    if (!g) return [color.gray("Select a guest.")];
    const memPct = g.maxmem ? (g.mem / g.maxmem) * 100 : 0;
    const diskPct = g.maxdisk ? (g.disk / g.maxdisk) * 100 : 0;
    const field = (k: string, v: string) => `${color.gray(padEnd(k, 10))} ${v}`;
    const rows = [
      field("Name", color.bold(g.name)),
      field("VMID", String(g.vmid)),
      field("Kind", g.type === "qemu" ? "QEMU VM" : "LXC container"),
      field("OS", this.selOs || color.gray("…")),
      field("Node", g.node),
      field("Status", g.status === "running" ? color.green(g.status) : color.yellow(g.status)),
      field("Cores", String(g.maxcpu)),
      field("Uptime", upt(g.uptime)),
      "",
      field("CPU", g.status === "running" ? `${bar(Math.min(100, g.cpu * 100), 18)} ${(g.cpu * 100).toFixed(1)}%` : color.gray("—")),
      field("Memory", g.status === "running" ? `${bar(memPct, 18)} ${bytes(g.mem)}/${bytes(g.maxmem)}` : color.gray("—")),
      field("Disk", `${bar(diskPct, 18)} ${bytes(g.disk)}/${bytes(g.maxdisk)}`),
      "",
      color.dim("Press [s] to view snapshots."),
    ];
    return rows.slice(0, height).map((r) => truncate(r, width));
  }

  private snapRows(width: number, height: number): string[] {
    if (this.snaps.length === 0) return [color.gray("No snapshots.")];
    return this.snaps.slice(0, height).map((s) => {
      const name = String(s.name ?? "");
      const desc = String(s.description ?? "").replace(/\n/g, " ");
      const mark = name === "current" ? color.green("● ") : color.gray("○ ");
      return truncate(`${mark}${color.bold(padEnd(name, 16))} ${color.dim(desc)}`, width);
    });
  }

  private footerKeys(cols: number): string {
    const keys = this.config.readOnly
      ? "↑/↓ move · s snapshots · r refresh · q quit"
      : "↑/↓ move · s snapshots · S start · d shutdown · x stop · b reboot · r refresh · q quit";
    const status = this.status ? `  ${this.status}` : "";
    return truncate(` ${color.gray(keys)}${status}`, cols);
  }

  private footerBrand(cols: number): string {
    const text = `${color.accent("SoyRage Agency")} ${color.dim("·")} ${color.brightBlue(BRAND.url)} ${color.dim("·")} ${color.yellow("★")} star us ${color.dim("·")} ${color.dim("support")} ${color.brightBlue(BRAND.donate)}`;
    return " " + text + " ".repeat(Math.max(0, cols - 2 - stripLen(text)));
  }
}

/** Visible length ignoring ANSI escapes. */
function stripLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
