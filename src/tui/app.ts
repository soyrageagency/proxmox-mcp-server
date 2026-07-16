/**
 * Terminal UI application.
 *
 * A professional, feature-rich lazydocker-style TUI for a Proxmox VE cluster.
 * Tabbed views (Guests · Nodes · Storage · Tasks), column headers, a live
 * clock, guest search/filter, confirmation prompts for destructive actions,
 * per-guest OS + CPU/memory/disk gauges and one-key lifecycle control — all in
 * hand-rolled ANSI with zero UI dependencies, wrapped in a SoyRage welcome.
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

/** Visible length ignoring ANSI escapes. */
function stripLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

type Mode = "splash" | "main";
type View = "guests" | "nodes" | "storage" | "tasks";
type Input = "normal" | "filter" | "confirm";
const VIEWS: View[] = ["guests", "nodes", "storage", "tasks"];
const VIEW_LABEL: Record<View, string> = { guests: "Guests", nodes: "Nodes", storage: "Storage", tasks: "Tasks" };

interface StorageRow { node: string; storage: string; type: string; used: number; total: number; active: boolean; content: string; }

/** The interactive terminal application. */
export class TuiApp {
  private mode: Mode = "splash";
  private view: View = "guests";
  private input: Input = "normal";
  private nodes: NodeSummary[] = [];
  private guests: Guest[] = [];
  private storages: StorageRow[] = [];
  private tasks: Array<Record<string, unknown>> = [];
  private selected = 0;
  private showSnaps = false;
  private snaps: Array<Record<string, unknown>> = [];
  private selOs = "";
  private filter = "";
  private confirm: { kind: "start" | "shutdown" | "stop" | "reboot"; guest: Guest } | null = null;
  private status = "";
  private clusterName = "";
  private pveVersion = "";
  private timer: NodeJS.Timeout | null = null;
  private clock: NodeJS.Timeout | null = null;
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

    if (this.input === "confirm") return this.onConfirmKey(key);
    if (this.input === "filter") return this.onFilterKey(key);

    switch (key) {
      case "q":
        return void this.quit();
      case "1": return this.setView("guests");
      case "2": return this.setView("nodes");
      case "3": return this.setView("storage");
      case "4": return this.setView("tasks");
      case "\t": return this.setView(VIEWS[(VIEWS.indexOf(this.view) + 1) % VIEWS.length]);
      case "\x1b[A": case "k": return this.move(-1);
      case "\x1b[B": case "j": return this.move(1);
      case "r": this.status = "Refreshing…"; return void this.refresh();
      case "/":
        if (this.view === "guests") { this.input = "filter"; this.render(); }
        return;
      case "s":
        if (this.view === "guests") {
          this.showSnaps = !this.showSnaps;
          if (this.showSnaps) void this.loadSnaps(); else this.render();
        }
        return;
      case "S": return this.requestAction("start", false);
      case "d": return this.requestAction("shutdown", false);
      case "x": return this.requestAction("stop", true);
      case "b": return this.requestAction("reboot", false);
      default: return;
    }
  }

  private onFilterKey(key: string): void {
    if (key === "\r" || key === "\n" || key === "\x1b") { this.input = "normal"; this.render(); return; }
    if (key === "\x7f" || key === "\b") { this.filter = this.filter.slice(0, -1); }
    else if (key >= " " && key.length === 1) { this.filter += key; }
    this.selected = 0;
    this.render();
  }

  private onConfirmKey(key: string): void {
    const pending = this.confirm;
    this.confirm = null;
    this.input = "normal";
    if ((key === "y" || key === "Y") && pending) void this.doAction(pending.kind, pending.guest);
    else { this.status = color.gray("Cancelled."); this.render(); }
  }

  private setView(v: View): void {
    if (this.view === v) return;
    this.view = v;
    this.selected = 0;
    this.showSnaps = false;
    this.render();
    void this.loadView();
  }

  private move(delta: number): void {
    const n = this.rowsForView().length;
    if (n === 0) return;
    this.selected = (this.selected + delta + n) % n;
    this.showSnaps = false;
    if (this.view === "guests") { this.selOs = ""; this.render(); void this.updateSelOs(); }
    else this.render();
  }

  private requestAction(kind: "start" | "shutdown" | "stop" | "reboot", needsConfirm: boolean): void {
    if (this.view !== "guests") return;
    const g = this.filteredGuests()[this.selected];
    if (!g) return;
    if (this.config.readOnly) { this.status = color.yellow("Read-only mode — actions are disabled."); this.render(); return; }
    if (needsConfirm) { this.confirm = { kind, guest: g }; this.input = "confirm"; this.render(); return; }
    void this.doAction(kind, g);
  }

  private async doAction(kind: "start" | "shutdown" | "stop" | "reboot", g: Guest): Promise<void> {
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

  private current(): Guest | undefined {
    return this.filteredGuests()[this.selected];
  }

  // ---- Data ---------------------------------------------------------------

  private async enterMain(): Promise<void> {
    this.mode = "main";
    // Best-effort cluster metadata for the header.
    this.client.version().then((v) => { this.pveVersion = String(v.version ?? ""); }).catch(() => {});
    this.client.clusterStatus().then((s) => {
      const c = (s ?? []).find((x) => x.type === "cluster");
      this.clusterName = c ? String(c.name ?? "") : "standalone";
    }).catch(() => {});
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), 5000);
    this.clock = setInterval(() => this.render(), 1000);
    if (typeof this.clock.unref === "function") this.clock.unref();
  }

  private async loadView(): Promise<void> {
    await this.fetchViewData();
    this.render();
  }

  private async fetchViewData(): Promise<void> {
    try {
      if (this.view === "storage") {
        const rows: StorageRow[] = [];
        const seen = new Set<string>();
        for (const n of this.nodes) {
          const list = await this.client.storage(n.node);
          for (const s of list ?? []) {
            const id = String(s.storage ?? "");
            if (seen.has(id)) continue;
            seen.add(id);
            rows.push({
              node: n.node, storage: id, type: String(s.type ?? "—"),
              used: Number(s.used ?? 0), total: Number(s.total ?? 0),
              active: Boolean(Number(s.active)), content: String(s.content ?? ""),
            });
          }
        }
        this.storages = rows;
      } else if (this.view === "tasks") {
        const node = this.nodes[0]?.node;
        this.tasks = node ? await this.client.tasks(node, 30) : [];
      } else if (this.view === "guests") {
        await this.fetchSelOs();
      }
    } catch (err) {
      this.status = color.red(`Error: ${(err as Error).message}`);
    }
  }

  private async updateSelOs(): Promise<void> { await this.fetchSelOs(); this.render(); }

  private async fetchSelOs(): Promise<void> {
    const g = this.current();
    if (!g) { this.selOs = ""; return; }
    try {
      const info = await this.client.osInfo(g);
      const agent = (info.agent as { result?: Record<string, unknown> } | undefined)?.result;
      this.selOs = String(agent?.["pretty-name"] ?? agent?.name ?? info.ostype ?? "");
    } catch { this.selOs = ""; }
  }

  private async loadSnaps(): Promise<void> {
    const g = this.current();
    if (!g) return;
    this.snaps = [{ name: "Loading…" }];
    this.render();
    try { this.snaps = await this.client.snapshots(g); }
    catch (err) { this.snaps = [{ name: `Error: ${(err as Error).message}` }]; }
    this.render();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const [nodes, guests] = await Promise.all([this.client.nodes(), this.client.guests()]);
      this.nodes = nodes;
      this.guests = guests.sort((a, b) => a.vmid - b.vmid);
      const n = this.rowsForView().length;
      if (this.selected >= n) this.selected = Math.max(0, n - 1);
      await this.loadView();
    } catch (err) {
      this.status = color.red(`Error: ${(err as Error).message}`);
      this.render();
    } finally { this.refreshing = false; }
  }

  private quit(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.clock) clearInterval(this.clock);
    this.out.write(ctl.showCursor + ctl.exitAlt);
    this.out.write(
      `\n  Thanks for using ${color.accent(BRAND.product)} by ${color.bold(BRAND.author)} — ${color.brightBlue(BRAND.url)}\n` +
        `  ${color.yellow("★")} If it helped you, please leave a star. See you soon!\n\n`,
    );
    process.exit(0);
  }

  // ---- Filtering ----------------------------------------------------------

  private filteredGuests(): Guest[] {
    const f = this.filter.trim().toLowerCase();
    if (!f) return this.guests;
    return this.guests.filter((g) => g.name.toLowerCase().includes(f) || String(g.vmid).includes(f));
  }

  private rowsForView(): unknown[] {
    switch (this.view) {
      case "guests": return this.filteredGuests();
      case "nodes": return this.nodes;
      case "storage": return this.storages;
      case "tasks": return this.tasks;
    }
  }

  // ---- Rendering ----------------------------------------------------------

  private cols(): number { return this.out.columns && this.out.columns > 20 ? this.out.columns : 100; }
  private rows(): number { return this.out.rows && this.out.rows > 10 ? this.out.rows : 30; }

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

  private renderSplash(): void { this.paint(this.splashLines()); }

  /** Render one static main frame to a string (for `--frame`). */
  async frame(cols = 100, rows = 30, view = "guests"): Promise<string> {
    this.mode = "main";
    this.view = (VIEWS.includes(view as View) ? view : "guests") as View;
    const [nodes, guests] = await Promise.all([this.client.nodes(), this.client.guests()]);
    this.nodes = nodes;
    this.guests = guests.sort((a, b) => a.vmid - b.vmid);
    this.pveVersion = "8.2.4";
    this.clusterName = "soyrage-lab";
    await this.fetchViewData(); // no render side-effect (keeps --frame output clean)
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
    lines.push(this.tabBar(cols));

    const bodyHeight = Math.max(6, rows - 5);
    if (this.view === "guests") this.buildGuestsBody(lines, cols, bodyHeight);
    else this.buildTableBody(lines, cols, bodyHeight);

    lines.push(this.footerKeys(cols));
    lines.push(this.footerBrand(cols));
    return lines;
  }

  private headerLine(cols: number): string {
    const brand = `${color.accent(color.bold("SOYRAGE"))} ${color.gray("▸")} ${color.bold("Proxmox TUI")}`;
    const cluster = this.clusterName ? ` ${color.gray("·")} ${color.cyan(this.clusterName)}` : "";
    const badges: string[] = [];
    if (this.client.isDemo) badges.push(color.yellow(" DEMO "));
    if (this.config.readOnly) badges.push(color.brightBlue(" READ-ONLY "));
    const online = this.nodes.filter((n) => n.status === "online").length;
    const clock = new Date().toTimeString().slice(0, 8);
    const right = `${badges.join(" ")}  ${this.pveVersion ? color.gray("PVE " + this.pveVersion) + " " + color.dim("·") + " " : ""}${color.gray(clock)} ${color.dim("·")} ${color.gray("Nodes")} ${online}/${this.nodes.length}`;
    const left = ` ${brand}${cluster}`;
    const gap = Math.max(1, cols - 1 - stripLen(left) - stripLen(right));
    return `${left}${" ".repeat(gap)}${right}`;
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

  private tabBar(cols: number): string {
    const tabs = VIEWS.map((v, i) => {
      const label = ` ${i + 1} ${VIEW_LABEL[v]} `;
      return v === this.view ? color.bgAccent(color.bold(label)) : color.gray(label);
    }).join(color.dim("│"));
    const hint = this.filter ? color.yellow(`  filter: ${this.filter}`) : "";
    const line = ` ${tabs}${hint}`;
    return line + " ".repeat(Math.max(0, cols - 1 - stripLen(line)));
  }

  // ---- Guests view (two columns) -----------------------------------------

  private buildGuestsBody(lines: string[], cols: number, bodyHeight: number): void {
    const leftW = Math.max(40, Math.floor(cols * 0.48));
    const rightW = cols - leftW - 1;
    const left = drawBox(
      `Guests (${this.filteredGuests().length}${this.filter ? "/" + this.guests.length : ""})`,
      this.guestRows(leftW - 4, bodyHeight - 2),
      leftW, bodyHeight,
    );
    const right = drawBox(
      this.showSnaps ? `Snapshots · ${this.current()?.name ?? ""}` : "Details",
      this.showSnaps ? this.snapRows(rightW - 4, bodyHeight - 2) : this.detailRows(rightW - 4, bodyHeight - 2),
      rightW, bodyHeight,
    );
    for (let i = 0; i < bodyHeight; i++) lines.push(`${left[i] ?? ""} ${right[i] ?? ""}`);
  }

  private guestRows(width: number, height: number): string[] {
    const list = this.filteredGuests();
    const rows: string[] = [];
    // Column header.
    const nameW = Math.max(10, width - 22);
    rows.push(color.gray(`   ${padEnd("VMID KIND NAME", nameW + 10)} ${padStart("CPU", 5)} ${padStart("MEM", 6)}`));
    for (let i = 0; i < list.length && i < height - 1; i++) {
      const g = list[i];
      const dot = g.status === "running" ? color.green("●") : g.status === "stopped" ? color.red("●") : color.yellow("●");
      const kind = g.type === "qemu" ? color.brightCyan("VM") : color.magenta("CT");
      const cpu = g.status === "running" ? `${(g.cpu * 100).toFixed(1)}%` : "—";
      const mem = g.status === "running" ? bytes(g.mem) : "—";
      const name = padEnd(`${String(g.vmid).padEnd(4)} ${kind} ${g.name}`, Math.max(10, width - 15));
      let line = `${dot} ${name} ${padStart(cpu, 5)} ${padStart(mem, 6)}`;
      if (i === this.selected) line = color.bgAccent(padEnd(line, width));
      rows.push(line);
    }
    if (list.length === 0) rows.push(color.gray(this.filter ? "No guests match the filter." : "No guests. (Try PROXMOX_MCP_DEMO=true)"));
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
      color.dim("[s] snapshots   [S] start  [d] shutdown  [x] stop  [b] reboot"),
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

  // ---- Full-width table views (nodes / storage / tasks) ------------------

  private buildTableBody(lines: string[], cols: number, bodyHeight: number): void {
    let title = VIEW_LABEL[this.view];
    let content: string[] = [];
    const inner = cols - 4;
    if (this.view === "nodes") {
      title = `Nodes (${this.nodes.length})`;
      content = this.tableLines(
        ["NODE", "STATUS", "CPU", "MEMORY", "UPTIME"],
        this.nodes.map((n) => [
          n.node, n.status,
          `${bar(n.cpu * 100, 12)} ${(n.cpu * 100).toFixed(1)}%`,
          `${bar(n.maxmem ? (n.mem / n.maxmem) * 100 : 0, 12)} ${bytes(n.mem)}/${bytes(n.maxmem)}`,
          upt(n.uptime),
        ]), inner, bodyHeight - 2,
      );
    } else if (this.view === "storage") {
      title = `Storage (${this.storages.length})`;
      content = this.tableLines(
        ["STORAGE", "TYPE", "STATE", "CONTENT", "USAGE"],
        this.storages.map((s) => {
          const pct = s.total ? (s.used / s.total) * 100 : 0;
          return [
            s.storage, s.type, s.active ? color.green("active") : color.gray("inactive"),
            truncate(s.content, 22),
            `${bar(pct, 12)} ${bytes(s.used)}/${bytes(s.total)}`,
          ];
        }), inner, bodyHeight - 2,
      );
    } else if (this.view === "tasks") {
      title = `Recent tasks (${this.tasks.length})`;
      const now = Math.floor(Date.now() / 1000);
      content = this.tableLines(
        ["TYPE", "ID", "USER", "STATUS", "WHEN"],
        this.tasks.map((t) => {
          const end = Number(t.endtime ?? 0);
          const st = end ? String(t.status ?? "?") : "running";
          const statusCol = st === "OK" ? color.green("OK") : end ? color.red(truncate(st, 18)) : color.yellow("running");
          return [
            truncate(String(t.type ?? ""), 16), truncate(String(t.id ?? "—"), 12),
            truncate(String(t.user ?? "—"), 16), statusCol,
            end ? upt(now - Number(t.starttime ?? 0)) + " ago" : "—",
          ];
        }), inner, bodyHeight - 2,
      );
    }
    const box = drawBox(title, content, cols, bodyHeight);
    for (let i = 0; i < bodyHeight; i++) lines.push(box[i] ?? "");
  }

  /** Render a header + rows table sized to `inner` width, with selection. */
  private tableLines(headers: string[], rows: string[][], inner: number, height: number): string[] {
    const cols = headers.length;
    const widths = headers.map((h, i) => Math.max(stripLen(h), ...rows.map((r) => stripLen(r[i] ?? ""))));
    // Shrink to fit: trim the widest column until the total fits.
    const gap = 2;
    const totalGap = (cols - 1) * gap;
    let sum = () => widths.reduce((a, b) => a + b, 0) + totalGap;
    while (sum() > inner) {
      const wi = widths.indexOf(Math.max(...widths));
      if (widths[wi] <= 6) break;
      widths[wi] -= 1;
    }
    const cell = (s: string, w: number) => padEnd(truncate(s, w), w);
    const line = (cells: string[]) => cells.map((c, i) => cell(c ?? "", widths[i])).join(" ".repeat(gap));
    const out: string[] = [];
    out.push(color.gray(line(headers)));
    out.push(color.gray("─".repeat(Math.min(inner, sum()))));
    for (let i = 0; i < rows.length && i < height - 2; i++) {
      let l = line(rows[i]);
      if (i === this.selected) l = color.bgAccent(padEnd(l, inner));
      out.push(l);
    }
    if (rows.length === 0) out.push(color.gray("(nothing to show)"));
    return out;
  }

  // ---- Footers ------------------------------------------------------------

  private footerKeys(cols: number): string {
    let keys: string;
    if (this.input === "filter") keys = `filter: ${color.bold(this.filter)}${color.dim("▏")}   ${color.gray("Enter/Esc to close")}`;
    else if (this.input === "confirm" && this.confirm) keys = color.yellow(`Confirm ${this.confirm.kind} ${this.confirm.guest.name} (VMID ${this.confirm.guest.vmid})?  y / n`);
    else if (this.view === "guests") keys = this.config.readOnly
      ? "1-4 tabs · ↑/↓ move · / filter · s snapshots · r refresh · q quit"
      : "1-4 tabs · ↑/↓ · / filter · s snap · S start · d shutdown · x stop · b reboot · r · q";
    else keys = "1-4 tabs · ↑/↓ move · r refresh · q quit";
    const status = this.status && this.input === "normal" ? `  ${this.status}` : "";
    return truncate(` ${color.gray(keys)}${status}`, cols);
  }

  private footerBrand(cols: number): string {
    const text = `${color.accent("SoyRage Agency")} ${color.dim("·")} ${color.brightBlue(BRAND.url)} ${color.dim("·")} ${color.yellow("★")} star us ${color.dim("·")} ${color.dim("support")} ${color.brightBlue(BRAND.donate)}`;
    return " " + text + " ".repeat(Math.max(0, cols - 2 - stripLen(text)));
  }
}
