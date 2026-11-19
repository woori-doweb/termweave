/**
 * The Fleet telemetry console's readings, ported from GOAT (apps/web/src/components/fleet/
 * fleetTelemetry.ts, fleetQuota.ts and fleetCount.ts; MIT, see THIRD_PARTY_NOTICES.md). A GOAT
 * environment fans out to its SSH hosts; here each PC answers for itself, so there is one host
 * row per PC and no host a dispatcher reported.
 */
import type { HostPressureReason, HostStatus } from "../../shared/hostStatus.ts";
import { LOCAL_MACHINE, type Machine } from "../../shared/machines.ts";
import type { FleetMachine } from "./fleet.ts";
import { classifyFleetPane } from "./fleet.ts";
import { formatHealthDuration, isFleetConnectionWait, presentConnectionWait, type FleetConnection } from "./fleetConnection.ts";
import { cpuPercent, FLEET_HEAT_LABEL, FLEET_HEAT_THRESHOLDS, fleetMachineHeat, loadPerCore, memoryPercent, type FleetHeatTier, type FleetHostEntry, type FleetMachineHeat } from "./fleetHeat.ts";
import { t } from "./i18n.ts";
import { usageName, windowLabel } from "./usage.ts";

/** Ten minutes of 15 s samples. */
export const HOST_HISTORY_CAPACITY = 40;
/** Samples older than this are dropped, so a host that went quiet stops drawing an old line. */
const HOST_HISTORY_MAX_AGE_MS = 10 * 60_000;
/** A connected PC whose status read has waited this long is not answering. */
export const SLOW_ANSWER_MS = 10_000;

export function pushBounded<T>(list: ReadonlyArray<T>, item: T, capacity: number): ReadonlyArray<T> {
  if (capacity <= 0) return [];
  return [...list.slice(Math.max(0, list.length + 1 - capacity)), item];
}

/**
 * Percentages from 0 to 100; load is the one-minute average. Null where the host sent none.
 * `at` is the host's own clock and only tells samples apart; `seenAt` is this client's clock,
 * so retention and ages hold when a host's clock is off.
 */
export interface HostSample {
  readonly at: number;
  readonly seenAt: number;
  readonly cpu: number | null;
  readonly memory: number | null;
  readonly load: number | null;
}

export type HostHistory = ReadonlyMap<string, ReadonlyArray<HostSample>>;
/** The host-status entry each PC's last read gave, by machine id. */
export type HostReports = ReadonlyMap<string, FleetHostEntry>;

const percent = (value: number) => Math.min(100, Math.max(0, value * 100));

function sampleOf(metrics: HostStatus, seenAt: number): HostSample {
  return {
    at: metrics.sampled_at,
    seenAt,
    cpu: metrics.cpu_utilization === null ? null : percent(metrics.cpu_utilization),
    memory: metrics.total_memory_bytes > 0 ? percent(1 - metrics.available_memory_bytes / metrics.total_memory_bytes) : null,
    load: metrics.load_avg?.one_minute ?? null,
  };
}

/**
 * Appends each reachable PC's newest sample. A repeated `sampled_at` (a cached read) adds
 * nothing, so recording the same reads twice returns the same map. Last-known metrics of an
 * unreachable PC are not new readings and are not recorded.
 */
export function recordHostSamples(history: HostHistory, reports: HostReports, now: number, capacity = HOST_HISTORY_CAPACITY): HostHistory {
  let next: Map<string, ReadonlyArray<HostSample>> | null = null;
  const cutoff = now - HOST_HISTORY_MAX_AGE_MS;
  for (const [key, samples] of history) {
    if (samples.length > 0 && samples[0]!.seenAt >= cutoff) continue;
    const kept = samples.filter((sample) => sample.seenAt >= cutoff);
    next ??= new Map(history);
    if (kept.length === 0) next.delete(key);
    else next.set(key, kept);
  }
  for (const [key, entry] of reports) {
    if (entry.reachability !== "ok") continue;
    const samples = (next ?? history).get(key) ?? [];
    if (samples.some((sample) => sample.at === entry.metrics.sampled_at)) continue;
    next ??= new Map(history);
    next.set(key, pushBounded(samples, sampleOf(entry.metrics, now), capacity));
  }
  return next ?? history;
}

/** When this client last received a new reading from each PC, kept after its sparkline expires. */
export type HostLastSeen = ReadonlyMap<string, { readonly at: number; readonly seenAt: number }>;

export function recordLastSeen(lastSeen: HostLastSeen, reports: HostReports, now: number): HostLastSeen {
  let next: Map<string, { readonly at: number; readonly seenAt: number }> | null = null;
  for (const [key, entry] of reports) {
    if (entry.reachability !== "ok") continue;
    if ((next ?? lastSeen).get(key)?.at === entry.metrics.sampled_at) continue;
    next ??= new Map(lastSeen);
    next.set(key, { at: entry.metrics.sampled_at, seenAt: now });
  }
  return next ?? lastSeen;
}

export type FleetHostTone = "ok" | "stale" | "unreachable" | "unsupported" | "none";

export interface FleetHostRow {
  readonly key: string;
  readonly label: string;
  readonly machineId: string;
  readonly entry: FleetHostEntry | null;
  readonly tone: FleetHostTone;
}

function toneOf(entry: FleetHostEntry | null): FleetHostTone {
  if (entry === null) return "none";
  if (entry.reachability === "ok") return "ok";
  if (entry.reachability === "unsupported") return "unsupported";
  return entry.lastKnown === true && entry.metrics !== undefined ? "stale" : "unreachable";
}

/** One row per Fleet PC, from the same reads as the graph's heat, so a row and its node never disagree. */
export const fleetHostRows = (machines: ReadonlyArray<Pick<FleetMachine, "id" | "label">>, reports: HostReports): ReadonlyArray<FleetHostRow> =>
  machines.map((machine) => {
    const entry = reports.get(machine.id) ?? null;
    return { key: machine.id, label: machine.label, machineId: machine.id, entry, tone: toneOf(entry) };
  });

/** The metrics a row shows: live, or the last ones of a PC that stopped answering. */
export const rowMetrics = (row: FleetHostRow): HostStatus | undefined =>
  row.entry === null || row.entry.reachability === "unsupported" ? undefined : row.entry.metrics;

/** "last known 4m ago" for a PC that stopped answering, timed from when this client last saw it answer. */
export function lastKnownLabel(row: FleetHostRow, lastSeen: HostLastSeen, now: number): string | null {
  const sampledAt = rowMetrics(row)?.sampled_at;
  if (row.tone !== "stale" || sampledAt === undefined) return null;
  const seenAt = lastSeen.get(row.key)?.seenAt ?? sampledAt;
  const elapsed = now - Math.min(seenAt, now);
  return elapsed < 1000 ? t("last known just now") : t("last known {age} ago", { age: formatHealthDuration(elapsed) });
}

export function signalTier(key: keyof typeof FLEET_HEAT_THRESHOLDS, value: number | null): FleetHeatTier {
  if (value === null) return "normal";
  const threshold = FLEET_HEAT_THRESHOLDS[key];
  if (value >= threshold.burning) return "burning";
  if (value >= threshold.hot) return "hot";
  return value >= threshold.warm ? "warm" : "normal";
}

const TIER_RANK: Record<FleetHeatTier, number> = { normal: 0, warm: 1, hot: 2, burning: 3 };

export interface HottestHost {
  readonly row: FleetHostRow;
  /** the PC's tier as the graph shows it */
  readonly tier: FleetHeatTier;
  readonly cpu: number | null;
  readonly loadPerCore: number | null;
}

/** The hottest host's headline reading: CPU, else load per core, else the tier memory or quota set. */
export function hottestReading(hottest: HottestHost): string {
  if (hottest.cpu !== null) return hottest.cpu + "%";
  if (hottest.loadPerCore !== null) return hottest.loadPerCore.toFixed(1) + "/core";
  return t(FLEET_HEAT_LABEL[hottest.tier]);
}

/** The reachable PC working hardest: highest heat tier, then CPU, then load per core. */
export function hottestHost(rows: ReadonlyArray<FleetHostRow>, heat: ReadonlyMap<string, FleetMachineHeat>): HottestHost | null {
  let best: { host: HottestHost; score: readonly [number, number] } | null = null;
  for (const row of rows) {
    if (row.entry?.reachability !== "ok") continue;
    const metrics = row.entry.metrics;
    const cpu = cpuPercent(metrics);
    const perCore = loadPerCore(metrics);
    const tier = heat.get(row.machineId)?.tier ?? fleetMachineHeat(row.entry).tier;
    const score = [TIER_RANK[tier], cpu ?? (perCore === null ? -1 : Math.min(100, perCore * 100))] as const;
    if (best === null || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) best = { host: { row, tier, cpu, loadPerCore: perCore }, score };
  }
  return best?.host ?? null;
}

export type FleetAlertTone = "destructive" | "warning" | "muted";

/** The one next step an alert offers, run against the PC itself. */
export type FleetAlertActionKind = "retry" | "update_bridge" | "setup";

export interface FleetAlert {
  readonly key: string;
  readonly tone: FleetAlertTone;
  readonly label: string;
  readonly detail: string;
  readonly action?: { readonly kind: FleetAlertActionKind; readonly machineId: string };
  /** extra lines for the tooltip */
  readonly lines?: ReadonlyArray<string>;
}

const ALERT_ORDER: Record<FleetAlertTone, number> = { destructive: 0, warning: 1, muted: 2 };

function connectionAlert(connection: FleetConnection, now: number): (Pick<FleetAlert, "tone" | "detail"> & { readonly retry: boolean }) | null {
  const detail = connection.reason === null ? connection.label : connection.reason;
  const elapsed = connection.since === undefined ? 0 : now - connection.since;
  switch (connection.state) {
    case "attention":
      return { tone: "destructive", detail, retry: false };
    case "connecting":
    case "reconnecting": {
      if (connection.since === undefined) return { tone: "warning", detail, retry: false };
      const wait = presentConnectionWait({ step: connection.step ?? null, sinceMs: connection.since, nowMs: now });
      return { tone: "warning", detail: connection.reason === null ? wait.text : `${wait.text} · ${connection.reason}`, retry: wait.slow };
    }
    case "degraded":
      return { tone: "warning", detail, retry: true };
    case "unreachable":
      return { tone: "muted", detail: (elapsed < 60_000 ? connection.label : t("{state} for {duration}", { state: connection.label, duration: formatHealthDuration(elapsed) })) + (connection.reason === null ? "" : ` · ${connection.reason}`), retry: true };
    case "offline":
      return { tone: "muted", detail: connection.label, retry: false };
    default:
      return null;
  }
}

/** Slow connection waits, by machine id: the graph stops their marching edges. */
export function slowConnectionWaits(connections: ReadonlyMap<string, FleetConnection>, now: number): ReadonlySet<string> {
  const slow = new Set<string>();
  for (const [machineId, connection] of connections) {
    if (!isFleetConnectionWait(connection.state) || connection.since === undefined) continue;
    if (presentConnectionWait({ step: null, sinceMs: connection.since, nowMs: now }).slow) slow.add(machineId);
  }
  return slow;
}

/**
 * Connections that are not up, PCs that stopped answering or cannot report, and PCs under
 * pressure. A PC whose connection is down already says so, so its unreachable host status is
 * not repeated.
 */
export function fleetAlerts(rows: ReadonlyArray<FleetHostRow>, connections: ReadonlyMap<string, FleetConnection>, now: number, options: {
  readonly lastSeen?: HostLastSeen;
  /** PCs whose host-status read is still waiting, by when it started */
  readonly pendingSince?: ReadonlyMap<string, number>;
  /** what each PC needs before it can reconnect (Machine.action_required) */
  readonly actions?: ReadonlyMap<string, Machine["action_required"]>;
} = {}): ReadonlyArray<FleetAlert> {
  const lastSeen = options.lastSeen ?? new Map();
  const alerts: FleetAlert[] = [];
  for (const row of rows) {
    const act = (kind: FleetAlertActionKind) => ({ action: { kind, machineId: row.machineId } });
    const connection = connections.get(row.machineId);
    const fromConnection = connection === undefined ? null : connectionAlert(connection, now);
    if (fromConnection !== null) {
      const { retry, ...alert } = fromConnection;
      const needed = options.actions?.get(row.machineId);
      // the local PC is this server: there is nothing to reconnect to
      const action = needed === "update_bridge" ? act("update_bridge") : needed === "setup" ? act("setup") : retry && row.machineId !== LOCAL_MACHINE ? act("retry") : {};
      alerts.push({ key: row.key + ":connection", label: row.label, ...alert, ...action });
    }
    const entry = row.entry;
    if (entry === null) continue;
    if (fromConnection === null && (row.tone === "stale" || row.tone === "unreachable")) {
      const lastKnown = lastKnownLabel(row, lastSeen, now);
      const why = entry.reachability === "unreachable" ? entry.message ?? null : null;
      const head = why ?? t("Unreachable");
      alerts.push({ key: row.key + ":reach", tone: "warning", label: row.label, detail: lastKnown === null ? head : `${head}, ${lastKnown}` });
    }
    const pending = options.pendingSince?.get(row.machineId);
    if (fromConnection === null && row.tone === "ok" && pending !== undefined && now - pending >= SLOW_ANSWER_MS) {
      alerts.push({ key: row.key + ":responsive", tone: "warning", label: row.label, detail: t("Not answering · waited {duration}", { duration: formatHealthDuration(now - pending) }) });
    }
    if (row.tone === "unsupported") alerts.push({ key: row.key + ":unsupported", tone: "muted", label: row.label, detail: t("Update the bridge to report status"), ...act("update_bridge") });
    // the host's own verdict, held with hysteresis there
    const pressure = entry.reachability === "ok" ? entry.metrics.pressure : undefined;
    if (pressure !== undefined && pressure.level !== "ok") {
      const top = pressure.reasons[0];
      const critical = pressure.level === "critical";
      const head = top?.signal === "disk" ? (critical ? t("Almost out of disk space") : t("Low on disk space")) : critical ? t("Overloaded") : t("Under heavy load");
      alerts.push({ key: row.key + ":pressure", tone: critical ? "destructive" : "warning", label: row.label, detail: top === undefined ? head : `${head}, ${pressureReason(top)}`, lines: pressure.reasons.slice(1).map(pressureReason) });
    }
  }
  return [...alerts].sort((left, right) => ALERT_ORDER[left.tone] - ALERT_ORDER[right.tone]);
}

/** A host's pressure reason in the reader's language; a host from before the readings sends only its English message. */
export function pressureReason(reason: HostPressureReason): string {
  if (typeof reason.value !== "number" || typeof reason.threshold !== "number") return reason.message;
  const { value, threshold } = reason;
  switch (reason.signal) {
    case "load": return t("load {value} per core (threshold {threshold})", { value, threshold });
    case "cpu": return t("CPU {value}% (threshold {threshold}%)", { value: Math.round(value), threshold });
    case "memory": return t("memory {value}% free (threshold {threshold}%)", { value, threshold });
    case "disk": return reason.free_percent === undefined || reason.threshold_percent === undefined
      ? t("disk {value} GiB free, under {threshold} GiB", { value, threshold })
      : t("disk {value} GiB free ({percent}%), under {threshold} GiB and {limit}%", { value, threshold, percent: reason.free_percent, limit: reason.threshold_percent });
    default: return reason.message;
  }
}

/** PCs drawn on the page that the count leaves out: GOAT counts only servers that answer. */
export interface FleetUncountedHost { readonly key: string; readonly label: string; readonly reason: string }

export function fleetUncountedMachines(machines: ReadonlyArray<FleetMachine>, connections: ReadonlyMap<string, FleetConnection>): ReadonlyArray<FleetUncountedHost> {
  return machines.filter((machine) => !machine.answering).map((machine) => {
    const connection = connections.get(machine.id);
    return { key: machine.id, label: machine.label, reason: connection === undefined ? t("Not connected") : connection.reason ?? connection.label };
  });
}

/** Hosts the console lists: how many report metrics, and which drawn PCs are not counted. */
export function fleetHostCount(rows: ReadonlyArray<FleetHostRow>, machines: ReadonlyArray<FleetMachine>, connections: ReadonlyMap<string, FleetConnection>) {
  return { reporting: rows.filter((row) => row.tone === "ok").length, uncounted: fleetUncountedMachines(machines, connections) };
}

/** Each pane's latest run: when it turned busy and when it went quiet, as GOAT reads a thread's latestRun. */
export type FleetRunLog = ReadonlyMap<string, { readonly machineId: string; readonly active: boolean; readonly started: number | null; readonly finished: number | null }>;

const THROUGHPUT_WINDOW_MS = 60 * 60_000;
export const THROUGHPUT_BUCKETS = 12;

/**
 * Advances the run log from the PCs as they are now. A pane first seen busy has no known start;
 * one seen turning busy starts now, and one going quiet finishes now. Panes of PCs that are not
 * connected are not read (their roster is a cache) and keep what they had; a closed pane keeps
 * its last run while that run is inside the window.
 */
export function recordFleetRuns(log: FleetRunLog, machines: ReadonlyArray<Machine>, now: number): FleetRunLog {
  const next = new Map<string, { machineId: string; active: boolean; started: number | null; finished: number | null }>();
  const read = new Set<string>();
  for (const machine of machines) {
    if (machine.state !== "connected" || machine.snapshot === null) continue;
    read.add(machine.id);
    for (const pane of machine.snapshot.panes) {
      if (!(pane.agent || pane.display_agent)) continue;
      const key = `${machine.id}:${pane.pane_id}`;
      const state = classifyFleetPane(pane);
      const active = state === "running" || state === "attention";
      const held = log.get(key);
      next.set(key, held === undefined ? { machineId: machine.id, active, started: null, finished: null }
        : active && !held.active ? { machineId: machine.id, active, started: now, finished: null }
        : !active && held.active ? { ...held, active, finished: now }
        : held);
    }
  }
  const inWindow = (run: { started: number | null; finished: number | null }) => Math.max(run.started ?? 0, run.finished ?? 0) >= now - THROUGHPUT_WINDOW_MS;
  for (const [key, run] of log) {
    if (next.has(key)) continue;
    if (!read.has(run.machineId) || inWindow(run)) next.set(key, read.has(run.machineId) ? { ...run, active: false } : run);
  }
  return next;
}

export interface FleetThroughput {
  readonly started: number;
  readonly finished: number;
  /** oldest bucket first */
  readonly startedBuckets: ReadonlyArray<number>;
  readonly finishedBuckets: ReadonlyArray<number>;
}

/** Runs started and finished in the last hour, from each pane's latest run, so a pane that ran twice counts once. */
export function fleetThroughput(log: FleetRunLog, now: number, windowMs = THROUGHPUT_WINDOW_MS, buckets = THROUGHPUT_BUCKETS): FleetThroughput {
  const from = now - windowMs;
  const bucketMs = windowMs / buckets;
  const startedBuckets: number[] = Array.from({ length: buckets }, () => 0);
  const finishedBuckets: number[] = Array.from({ length: buckets }, () => 0);
  const place = (at: number | null, into: number[]) => {
    if (at === null || !(at >= from && at <= now)) return false;
    into[Math.min(buckets - 1, Math.floor((at - from) / bucketMs))]! += 1;
    return true;
  };
  let started = 0;
  let finished = 0;
  for (const run of log.values()) {
    if (place(run.started, startedBuckets)) started += 1;
    if (place(run.finished, finishedBuckets)) finished += 1;
  }
  return { started, finished, startedBuckets, finishedBuckets };
}

export interface FleetQuotaRow {
  readonly key: string;
  readonly label: string;
  /** the PC it was read on, when the account does not say whose it is */
  readonly host: string | null;
  readonly windows: ReadonlyArray<{ readonly id: string; readonly label: string; readonly usedPercent: number }>;
  readonly peak: number;
  /** every window, for the tooltip, when more are kept than shown */
  readonly detail?: string;
  /** windows left off the row */
  readonly hidden: number;
}

/**
 * Plan usage per account. An account read on two PCs is one row, keeping the latest read; a
 * sign-in that names no account stays its PC's own row.
 */
export function fleetQuota(rows: ReadonlyArray<FleetHostRow>, maxWindows = 2): ReadonlyArray<FleetQuotaRow> {
  const byAccount = new Map<string, { usage: NonNullable<HostStatus["usage"]>["providers"][number]; host: string | null; at: number }>();
  for (const row of rows) {
    const metrics = rowMetrics(row);
    for (const usage of metrics?.usage?.providers ?? []) {
      if (usage.windows.length === 0) continue;
      const key = usage.account === null ? JSON.stringify([row.key, usage.key]) : usage.key;
      // the latest check wins: when the provider last reported, else when the PC was sampled
      const at = (usage.checked_at === null ? NaN : Date.parse(usage.checked_at)) || metrics!.sampled_at;
      const held = byAccount.get(key);
      if (held === undefined || held.at < at) byAccount.set(key, { usage, host: usage.account === null ? row.label : null, at });
    }
  }
  const quota = [...byAccount].map(([key, { usage, host }]): FleetQuotaRow => {
    const sorted = [...usage.windows].sort((left, right) => right.used_percent - left.used_percent);
    const windows = sorted.slice(0, maxWindows).map((window) => ({ id: `${window.kind}:${window.scope ?? ""}`, label: windowLabel(window), usedPercent: window.used_percent }));
    const hidden = sorted.length - windows.length;
    return {
      key, label: usageName(usage), host, windows, peak: windows[0]?.usedPercent ?? 0, hidden,
      ...(hidden > 0 ? { detail: sorted.map((window) => `${windowLabel(window)} ${Math.round(window.used_percent)}%`).join("\n") } : {}),
    };
  });
  return quota.sort((left, right) => right.peak - left.peak);
}

/**
 * One SVG path for a series in a width x height box, values from 0 to `max`. Gaps (null) break
 * the line; a single value draws a short level stroke so it still reads as a reading.
 */
export function sparklinePath(values: ReadonlyArray<number | null>, width: number, height: number, max: number, slots = HOST_HISTORY_CAPACITY): string {
  if (values.length === 0 || max <= 0) return "";
  const step = width / Math.max(1, slots - 1);
  const offset = width - step * (values.length - 1);
  const y = (value: number) => +(height - (Math.min(max, Math.max(0, value)) / max) * height).toFixed(2);
  let path = "";
  let open = false;
  values.forEach((value, index) => {
    if (value === null) { open = false; return; }
    const x = +(offset + step * index).toFixed(2);
    path += (open ? "L" : "M") + x + " " + y(value);
    open = true;
  });
  if (values.length === 1 && values[0] !== null) {
    const level = y(values[0]!);
    return "M" + +(width - step).toFixed(2) + " " + level + "L" + width + " " + level;
  }
  return path;
}

export { cpuPercent, memoryPercent };

/*
 * The run log this client keeps from the moment it loads: App feeds every PC update in, so the
 * console's hour holds runs seen while the Fleet page was closed.
 * ponytail: in memory, so a reload starts the hour empty; a server-side log if that matters.
 */
let observedRuns: FleetRunLog = new Map();
const runListeners = new Set<() => void>();
export function observeFleetRuns(machines: ReadonlyArray<Machine>, now = Date.now()): void {
  observedRuns = recordFleetRuns(observedRuns, machines, now);
  for (const listener of runListeners) listener();
}
export const observedFleetRuns = (): FleetRunLog => observedRuns;
/** For useSyncExternalStore: the console redraws when the log moves, not one PC update later. */
export function subscribeFleetRuns(listener: () => void): () => void {
  runListeners.add(listener);
  return () => { runListeners.delete(listener); };
}
