// Cases follow GOAT (https://github.com/goat-si/goat, MIT) at 18b984275d:
// apps/web/src/components/fleet/fleetTelemetry.test.ts and fleetConnection.test.ts. See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from "bun:test";
import type { HostStatus } from "../../shared/hostStatus.ts";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { fleetConnectionLegend, fleetConnectionsSince, presentConnectionWait, presentFleetConnection, type FleetConnection } from "./fleetConnection.ts";
import type { FleetHostEntry } from "./fleetHeat.ts";
import { fleetAlerts, fleetHostRows, fleetQuota, fleetThroughput, hottestHost, hottestReading, lastKnownLabel, pushBounded, recordFleetRuns, recordHostSamples, recordLastSeen, signalTier, slowConnectionWaits, sparklinePath, type HostReports } from "./fleetTelemetry.ts";

const GIB = 1024 ** 3;
const metrics = (overrides: Partial<HostStatus> = {}): HostStatus => ({
  sampled_at: 1_000, platform: "linux", machine_kind: "server", cpu_count: 4, cpu_utilization: 0.2,
  load_avg: { one_minute: 1, five_minutes: 1, fifteen_minutes: 1 }, available_memory_bytes: 8 * GIB, total_memory_bytes: 16 * GIB,
  disk: null, pressure: { level: "ok", reasons: [] }, usage: null, ...overrides,
});
const ok = (status: HostStatus): FleetHostEntry => ({ reachability: "ok", metrics: status });
const machines = [{ id: "local", label: "Mac" }, { id: "box", label: "box" }];

const pc = (id: string, overrides: Partial<Machine> = {}): Machine => ({ id, name: id, kind: id === "local" ? "local" : "ssh", enabled: true, state: "connected", error: null, snapshot: null, ...overrides });
const withPanes = (id: string, panes: Array<Partial<HerdrPane> & { pane_id: string }>): Machine => pc(id, {
  snapshot: { agents: [], layouts: [], tabs: [], workspaces: [], protocol: 1, version: "1",
    panes: panes.map((pane) => ({ agent: "claude", agent_status: "idle", focused: false, revision: 1, tab_id: "t", terminal_id: pane.pane_id, workspace_id: "w", ...pane })) },
});

describe("host history", () => {
  it("keeps only the newest items up to capacity", () => {
    expect(pushBounded([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
    expect(pushBounded([1], 2, 0)).toEqual([]);
  });

  it("appends a new sample once, ignores a repeated sampled_at, and skips last-known metrics", () => {
    const reports: HostReports = new Map([["local", ok(metrics({ sampled_at: 5 }))], ["box", { reachability: "unreachable", metrics: metrics(), lastKnown: true }]]);
    const once = recordHostSamples(new Map(), reports, 100);
    expect(once.get("local")).toEqual([{ at: 5, seenAt: 100, cpu: 20, memory: 50, load: 1 }]);
    expect(once.has("box")).toBe(false);
    expect(recordHostSamples(once, reports, 200)).toBe(once);
  });

  it("expires samples older than ten minutes by this client's clock", () => {
    const history = recordHostSamples(new Map(), new Map([["local", ok(metrics({ sampled_at: 1 }))]]), 0);
    expect(recordHostSamples(history, new Map(), 10 * 60_000 + 1).has("local")).toBe(false);
  });

  it("times a lost PC from when this client last saw it answer", () => {
    const seen = recordLastSeen(new Map(), new Map([["box", ok(metrics({ sampled_at: 7 }))]]), 1_000);
    expect(recordLastSeen(seen, new Map([["box", ok(metrics({ sampled_at: 7 }))]]), 9_000)).toBe(seen);
    const [row] = fleetHostRows([{ id: "box", label: "box" }], new Map([["box", { reachability: "unreachable", metrics: metrics({ sampled_at: 7 }), lastKnown: true }]]));
    expect(row!.tone).toBe("stale");
    expect(lastKnownLabel(row!, seen, 1_000 + 4 * 60_000)).toBe("last known 4m 0s ago");
  });

  it("draws one path, breaks on gaps, and right-aligns a short series", () => {
    expect(sparklinePath([0, 100], 100, 10, 100, 3)).toBe("M50 10L100 0");
    expect(sparklinePath([50, null, 50], 100, 10, 100, 3)).toBe("M0 5M100 5");
    expect(sparklinePath([50], 100, 10, 100, 3)).toBe("M50 5L100 5");
    expect(sparklinePath([], 100, 10, 100)).toBe("");
  });
});

describe("host rows and the hottest host", () => {
  it("gives every PC one row, toned by what its last read gave", () => {
    const rows = fleetHostRows([...machines, { id: "old", label: "old" }, { id: "new", label: "new" }], new Map<string, FleetHostEntry>([
      ["local", ok(metrics())], ["box", { reachability: "unreachable", message: "timed out" }], ["old", { reachability: "unsupported" }],
    ]));
    expect(rows.map((row) => row.tone)).toEqual(["ok", "unreachable", "unsupported", "none"]);
  });

  it("colors a reading on the graph's heat thresholds", () => {
    expect(signalTier("cpu", 59)).toBe("normal");
    expect(signalTier("cpu", 80)).toBe("hot");
    expect(signalTier("memory", 95)).toBe("burning");
    expect(signalTier("load", null)).toBe("normal");
  });

  it("picks the busiest reachable PC, using load per core when CPU is unknown", () => {
    const rows = fleetHostRows(machines, new Map([["local", ok(metrics({ cpu_utilization: 0.5 }))], ["box", ok(metrics({ cpu_utilization: null, load_avg: { one_minute: 6, five_minutes: 1, fifteen_minutes: 1 } }))]]));
    const hottest = hottestHost(rows, new Map());
    expect(hottest?.row.key).toBe("box");
    expect(hottestReading(hottest!)).toBe("1.5/core");
  });
});

describe("fleetAlerts", () => {
  const connections = (entries: Record<string, FleetConnection>) => new Map(Object.entries(entries));

  it("reports down connections, PCs that stopped answering, old bridges and pressure, most severe first", () => {
    const rows = fleetHostRows([...machines, { id: "old", label: "old" }, { id: "hot", label: "hot" }], new Map<string, FleetHostEntry>([
      ["local", { reachability: "unreachable", metrics: metrics(), lastKnown: true, message: "HTTP 502" }],
      ["old", { reachability: "unsupported" }],
      ["hot", ok(metrics({ pressure: { level: "critical", reasons: [{ signal: "disk", level: "critical", message: "disk 3 GiB free", value: 3, threshold: 15, free_percent: 1, threshold_percent: 5 }] } }))],
    ]));
    const alerts = fleetAlerts(rows, connections({ box: { state: "attention", label: "Needs attention", reason: "Update the bridge to reconnect" } }), 10_000, { actions: new Map([["box", "update_bridge"]]) });
    expect(alerts.map((alert) => [alert.key, alert.tone, alert.detail, alert.action?.kind])).toEqual([
      ["box:connection", "destructive", "Update the bridge to reconnect", "update_bridge"],
      ["hot:pressure", "destructive", "Almost out of disk space, disk 3 GiB free (1%), under 15 GiB and 5%", undefined],
      ["local:reach", "warning", "HTTP 502, last known 9s ago", undefined],
      ["old:unsupported", "muted", "Update the bridge to report status", "update_bridge"],
    ]);
  });

  it("times a connection attempt and offers a retry once it is slow, but never for this PC", () => {
    const rows = fleetHostRows(machines, new Map());
    const waiting = connections({ box: { state: "connecting", label: "Connecting", reason: null, since: 0, step: "Opening SSH" }, local: { state: "degraded", label: "Degraded", reason: "herdr is not running" } });
    const early = fleetAlerts(rows, waiting, 12_000);
    expect(early.find((alert) => alert.key === "box:connection")).toMatchObject({ detail: "Connecting · 12s · Opening SSH" });
    expect(early.find((alert) => alert.key === "box:connection")?.action).toBeUndefined();
    const late = fleetAlerts(rows, waiting, 45_000);
    expect(late.find((alert) => alert.key === "box:connection")).toMatchObject({ detail: "Still connecting · 45s · Opening SSH", action: { kind: "retry", machineId: "box" } });
    expect(late.find((alert) => alert.key === "local:connection")?.action).toBeUndefined();
    expect([...slowConnectionWaits(waiting, 45_000)]).toEqual(["box"]);
  });

  it("says a connected PC is not answering once its read has waited 10 s", () => {
    const rows = fleetHostRows(machines, new Map([["box", ok(metrics())]]));
    expect(fleetAlerts(rows, new Map(), 20_000, { pendingSince: new Map([["box", 5_000]]) }).map((alert) => alert.detail)).toEqual(["Not answering · waited 15s"]);
    expect(fleetAlerts(rows, new Map(), 20_000, { pendingSince: new Map([["box", 15_000]]) })).toEqual([]);
  });
});

describe("connections", () => {
  it("reads a TermWeave PC's state as the Fleet's connection states", () => {
    const base = pc("box");
    expect(presentFleetConnection({ ...base, snapshot: withPanes("box", []).snapshot }).state).toBe("connected");
    expect(presentFleetConnection(base)).toMatchObject({ state: "connecting", step: "Reading sessions" });
    expect(presentFleetConnection({ ...base, state: "reconnecting" }).state).toBe("reconnecting");
    expect(presentFleetConnection({ ...base, state: "reconnecting", error: "herdr is not running" })).toMatchObject({ state: "degraded", reason: "herdr is not running" });
    expect(presentFleetConnection({ ...base, state: "error", error: "Permission denied" })).toMatchObject({ state: "attention", reason: "Permission denied" });
    expect(presentFleetConnection({ ...base, state: "disconnected", action_required: "update_bridge" })).toMatchObject({ state: "attention", reason: "Update the bridge to reconnect" });
    expect(presentFleetConnection({ ...base, state: "disconnected" }).state).toBe("unreachable");
    expect(presentFleetConnection({ ...base, state: "disconnected", enabled: false }).state).toBe("offline");
    expect(presentFleetConnection({ ...base, updating: { job_id: "j", step: "Uploading", progress: null } })).toMatchObject({ state: "connecting", step: "Uploading" });
  });

  it("keeps when each state began and hands back the same map while nothing moves", () => {
    const first = fleetConnectionsSince([pc("box", { state: "connecting" })], new Map(), 100);
    expect(first.get("box")?.since).toBe(100);
    expect(fleetConnectionsSince([pc("box", { state: "connecting" })], first, 900)).toBe(first);
    const next = fleetConnectionsSince([pc("box", { state: "reconnecting" })], first, 900);
    expect(next.get("box")).toMatchObject({ state: "reconnecting", since: 900 });
  });

  it("words a wait and lists only the legend shapes shown", () => {
    expect(presentConnectionWait({ step: null, sinceMs: 0, nowMs: 72_000 })).toEqual({ slow: true, text: "Still connecting · 1m 12s" });
    expect(fleetConnectionLegend([{ state: "connected", label: "", reason: null }, { state: "offline", label: "", reason: null }]).map((entry) => entry.state)).toEqual(["connected", "unreachable"]);
  });
});

describe("throughput", () => {
  it("counts each pane's latest run that started or finished in the last hour, never a run first seen busy", () => {
    let log = recordFleetRuns(new Map(), [withPanes("box", [{ pane_id: "a", agent_status: "working" }, { pane_id: "b" }])], 0);
    log = recordFleetRuns(log, [withPanes("box", [{ pane_id: "a", agent_status: "done" }, { pane_id: "b", agent_status: "working" }])], 10 * 60_000);
    log = recordFleetRuns(log, [withPanes("box", [{ pane_id: "a", agent_status: "done" }, { pane_id: "b", agent_status: "blocked" }])], 20 * 60_000);
    const hour = fleetThroughput(log, 30 * 60_000);
    // a: first seen working (no start), finished at 10m; b: started at 10m and still busy
    expect({ started: hour.started, finished: hour.finished }).toEqual({ started: 1, finished: 1 });
    expect(hour.startedBuckets.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(fleetThroughput(log, 2 * 60 * 60_000)).toMatchObject({ started: 0, finished: 0 });
  });

  it("keeps a disconnected PC's runs as they were and forgets a closed pane once its run ages out", () => {
    const busy = recordFleetRuns(new Map(), [withPanes("box", [{ pane_id: "a" }])], 0);
    const started = recordFleetRuns(busy, [withPanes("box", [{ pane_id: "a", agent_status: "working" }])], 1_000);
    expect(recordFleetRuns(started, [pc("box", { state: "reconnecting" })], 2_000).get("box:a")).toEqual(started.get("box:a")!);
    expect(recordFleetRuns(started, [withPanes("box", [])], 2 * 60 * 60_000).has("box:a")).toBe(false);
  });
});

describe("fleetQuota", () => {
  it("merges an account read on two PCs, keeps the latest check, and sorts by the fullest window", () => {
    const account = (used: number, checked: string) => ({ id: "claude" as const, key: "claude:me", account: "me", plan: "max", problem: null, checked_at: checked, windows: [{ kind: "session" as const, scope: null, used_percent: used, resets_at: null }, { kind: "week" as const, scope: null, used_percent: 5, resets_at: null }, { kind: "week" as const, scope: "Opus", used_percent: 1, resets_at: null }] });
    const rows = fleetHostRows(machines, new Map([
      ["local", ok(metrics({ usage: { providers: [account(30, "2026-11-09T00:00:00Z")] } }))],
      ["box", ok(metrics({ usage: { providers: [account(60, "2026-11-09T01:00:00Z"), { id: "codex", key: "codex:path", account: null, plan: null, problem: null, checked_at: null, windows: [{ kind: "week", scope: null, used_percent: 90, resets_at: null }] }] } }))],
    ]));
    const quota = fleetQuota(rows);
    expect(quota.map((row) => [row.label, row.host, row.peak, row.hidden])).toEqual([["Codex", "box", 90, 0], ["Claude · me", null, 60, 1]]);
    expect(quota[1]!.windows.map((window) => window.label)).toEqual(["Session", "Weekly"]);
  });
});
