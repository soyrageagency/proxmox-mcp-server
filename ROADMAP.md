# Roadmap

What this project is for, what already works, and what comes next.

The goal is narrow on purpose: **let anyone run a Proxmox homelab by talking to
it**, without giving up the safety rails that keep a natural-language interface
from being a liability. Everything below is judged against that.

Dates are targets, not promises. If something slips it is because it was not
ready, and shipping a half-finished tool into your hypervisor is worse than
being late.

---

## Shipped

### v1.0 — the foundation
- **36 tools** across nodes, guests, storage, tasks, cluster, snapshots,
  lifecycle, management, backups and provisioning.
- **Safety rails that are on by default**: global read-only mode, a VMID/name
  allowlist, and destructive operations that must be confirmed.
- **A modular plugin system** — load exactly the surface you want, from
  *insight only* to the full toolbox, without touching code.
- **Terminal dashboard (`rageprox`)** with an AI command bar.
- **Demo mode** — realistic fabricated cluster, so you can try every tool
  without a Proxmox host anywhere near you.
- **Resilience suite** — backup verification by actually restoring to an
  ephemeral guest, patch orchestration with rollback, and DR drills that
  produce signed evidence reports (ISO 27001 / NIS2 / DORA mapped).
- **Standalone binaries** for Linux, macOS and Windows — no Node, no npm.

### Since v1.0
- **Streamable HTTP transport.** stdio means one server per client, on the
  client's machine — backwards for a homelab, where the thing being managed is
  the server. `PROXMOX_MCP_HTTP=true` runs one instance next to the cluster
  that every machine on your network connects to. Bearer auth, DNS-rebinding
  protection, loopback by default.
- **Diagnostics.** `cluster_health` answers "is anything wrong?" in one call —
  quorum, node pressure, storage headroom, guests that stopped, backup
  freshness and coverage. `find_idle_guests` finds long-uptime, zero-CPU guests
  holding RAM. `find_orphaned_disks` finds images whose VM no longer exists.
- **MCP prompts and resources.** Tools only answer questions you already knew
  how to ask. Prompts make *audit my cluster*, *plan a maintenance window*,
  *explain this guest* and *free up space* discoverable in the client itself.
- **MIT licensed**, on npm as `@soyrageagency/proxmox-mcp`, and on the official
  MCP registry.

---

## Next

### Now — one-command install on any Proxmox
The HTTP transport was the prerequisite. The remaining work is packaging:
- A `community-scripts/ProxmoxVE` entry, so this installs into an LXC with one
  command from any Proxmox host in the world.
- A `ghcr.io` image, for people who would rather run a container.
- `update_script` support, so upgrades are one command too.

### Next — make the safety rails finer
Read-only or read-write is a blunt instrument. What people actually want is
"you may restart the web VM, but never touch the database".
- Per-tool permissions, not just per-plugin.
- A dry-run mode that reports what *would* happen.
- An audit log of every mutating call, with who asked and what the assistant
  did.

### Later — the things that need real design first
- **Metrics and history.** Tools answer about *now*. "Has this VM been slowly
  eating more RAM for a month?" needs stored history, which needs a storage
  decision that does not turn a small tool into a database server.
- **Multi-cluster.** One server, several clusters, without the tool surface
  doubling.
- **Migration assistance.** Proposing where a guest should live based on actual
  load, rather than reporting where it currently is.

---

## Not planned

Some things are deliberately out of scope. Saying so is more useful than a
silent backlog:

- **A replacement for the Proxmox web UI.** This is for the questions that are
  awkward to click through, not for the ones that are already one click away.
- **Autonomous action.** The server will not decide on its own to restart your
  cluster at 3am. Destructive operations stay behind explicit confirmation, and
  that is not a limitation to be optimised away.
- **Telemetry.** No usage data leaves your machine. There is no analytics
  endpoint and there will not be one.

---

## Have an opinion?

The most useful thing you can send is *what you tried to ask your cluster and
couldn't*. Open an [issue](https://github.com/soyrageagency/proxmox-mcp-server/issues)
or a [discussion](https://github.com/soyrageagency/proxmox-mcp-server/discussions) —
a concrete missing question beats a feature request.
