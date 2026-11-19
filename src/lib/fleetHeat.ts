/**
 * How hard a Fleet PC is working, ported from GOAT (packages/client-runtime/src/state/fleetHeat.ts
 * and host-metrics.ts, MIT; see THIRD_PARTY_NOTICES.md) onto TermWeave's host status. The graph
 * colors a node by tier and sets the hottest ones alight.
 *
 * A tier is the highest one any signal reaches. Rising takes effect on the next sample; falling
 * waits until the signal drops a margin below the threshold, so a host idling around a boundary
 * does not flicker between two looks every 15 s.
 */
import type { HostStatus } from "../../shared/hostStatus.ts";
import { t } from "./i18n.ts";
import { PROVIDER_NAME, windowLabel } from "./usage.ts";

export type FleetHeatTier = "normal" | "warm" | "hot" | "burning";

export const FLEET_HEAT_TIERS: ReadonlyArray<FleetHeatTier> = ["normal", "warm", "hot", "burning"];

/** Each signal's warm, hot, and burning thresholds, and how far below one it must fall to leave. */
export const FLEET_HEAT_THRESHOLDS = {
  /** CPU in use, percent. One 200 ms sample is noisy, hence the wide margin. */
  cpu: { warm: 60, hot: 80, burning: 92, margin: 8 },
  /** One-minute load average per core. Above 1, work is queueing for a CPU. */
  load: { warm: 0.7, hot: 1, burning: 1.5, margin: 0.15 },
  /** Memory in use, percent, from available memory (not just free pages). */
  memory: { warm: 80, hot: 90, burning: 95, margin: 3 },
  /** The fullest plan usage window, percent. It only falls at a reset. */
  quota: { warm: 70, hot: 85, burning: 95, margin: 2 },
} as const;

type SignalKey = keyof typeof FLEET_HEAT_THRESHOLDS;

const clampPercent = (value: number) => Math.min(100, Math.max(0, Math.round(value)));

export const cpuPercent = (metrics: Pick<HostStatus, "cpu_utilization">): number | null =>
  metrics.cpu_utilization === null ? null : clampPercent(metrics.cpu_utilization * 100);

export const memoryPercent = (metrics: Pick<HostStatus, "available_memory_bytes" | "total_memory_bytes">): number | null =>
  metrics.total_memory_bytes > 0 ? clampPercent((1 - metrics.available_memory_bytes / metrics.total_memory_bytes) * 100) : null;

export const diskPercent = (metrics: Pick<HostStatus, "disk">): number | null =>
  metrics.disk === null || !(metrics.disk.total_bytes > 0) ? null : clampPercent((1 - metrics.disk.available_bytes / metrics.disk.total_bytes) * 100);

/** One-minute load per core; above 1 means work is queueing for a CPU. Null where the OS keeps no load average. */
export const loadPerCore = (metrics: Pick<HostStatus, "load_avg" | "cpu_count">): number | null =>
  metrics.load_avg === null || !(metrics.cpu_count > 0) ? null : metrics.load_avg.one_minute / metrics.cpu_count;

export interface FleetHeatSignals {
  readonly cpuPercent: number | null;
  readonly loadPerCore: number | null;
  readonly memoryPercent: number | null;
  /** The fullest plan-wide usage window across the PC's signed-in accounts. */
  readonly quota: { readonly label: string; readonly usedPercent: number } | null;
}

/**
 * Plan-wide windows only (a model's own limit is not the plan's), judged at the sample's own
 * time: a window whose reset has passed, or an account whose numbers are stale (expired sign-in,
 * failed read), does not count.
 */
export function fleetHeatSignals(metrics: Pick<HostStatus, "cpu_utilization" | "load_avg" | "cpu_count" | "available_memory_bytes" | "total_memory_bytes" | "usage" | "sampled_at">): FleetHeatSignals {
  let quota: FleetHeatSignals["quota"] = null;
  for (const account of metrics.usage?.providers ?? []) {
    if (account.problem === "expired" || account.problem === "failed") continue;
    for (const window of account.windows) {
      if (window.scope !== null) continue;
      if (window.resets_at !== null && Date.parse(window.resets_at) <= metrics.sampled_at) continue;
      if (quota !== null && window.used_percent <= quota.usedPercent) continue;
      quota = { label: `${PROVIDER_NAME[account.id]} ${windowLabel(window).toLowerCase()}`, usedPercent: window.used_percent };
    }
  }
  return { cpuPercent: cpuPercent(metrics), loadPerCore: loadPerCore(metrics), memoryPercent: memoryPercent(metrics), quota };
}

const signalValue = (signals: FleetHeatSignals, key: SignalKey): number | null =>
  key === "cpu" ? signals.cpuPercent : key === "load" ? signals.loadPerCore : key === "memory" ? signals.memoryPercent : signals.quota?.usedPercent ?? null;

/** 0 normal through 3 burning, with every threshold lowered by `slack` margins. */
function signalLevel(signals: FleetHeatSignals, key: SignalKey, slack: number): number {
  const value = signalValue(signals, key);
  if (value === null) return 0;
  const { warm, hot, burning, margin } = FLEET_HEAT_THRESHOLDS[key];
  const shift = margin * slack;
  return value >= burning - shift ? 3 : value >= hot - shift ? 2 : value >= warm - shift ? 1 : 0;
}

const SIGNAL_KEYS = Object.keys(FLEET_HEAT_THRESHOLDS) as ReadonlyArray<SignalKey>;
const levelOf = (signals: FleetHeatSignals, slack: number) => Math.max(...SIGNAL_KEYS.map((key) => signalLevel(signals, key, slack)));

/**
 * The tier for a new sample, given the tier the PC showed before. Going up is immediate; going
 * down holds the previous tier while any signal is still within its margin of that tier's threshold.
 */
export function fleetHeatTier(signals: FleetHeatSignals, previous: FleetHeatTier = "normal"): FleetHeatTier {
  const rising = levelOf(signals, 0);
  const before = FLEET_HEAT_TIERS.indexOf(previous);
  if (rising >= before) return FLEET_HEAT_TIERS[rising]!;
  const holding = Math.min(before, levelOf(signals, 1));
  return FLEET_HEAT_TIERS[Math.max(rising, holding)]!;
}

function formatSignal(signals: FleetHeatSignals, key: SignalKey): string | null {
  const value = signalValue(signals, key);
  if (value === null) return null;
  if (key === "cpu") return t("CPU {value}%", { value });
  if (key === "load") return t("load {value}/core", { value: value.toFixed(1) });
  if (key === "memory") return t("memory {value}%", { value });
  return `${signals.quota!.label} ${Math.round(value)}%`;
}

/** Why a PC is warm or hotter, hottest signal first. Empty when nothing is. */
export function fleetHeatReasons(signals: FleetHeatSignals): ReadonlyArray<string> {
  return SIGNAL_KEYS.map((key) => ({ key, level: signalLevel(signals, key, 0) }))
    .filter((signal) => signal.level > 0)
    .sort((left, right) => right.level - left.level)
    .flatMap((signal) => formatSignal(signals, signal.key) ?? []);
}

/**
 * `live` is a fresh sample. `stale` repeats the last one from a host that stopped answering,
 * `unavailable` is a host that answered with nothing to show, and `none` is a PC no read covers.
 * Only `live` heats a node.
 */
export type FleetHeatStatus = "live" | "stale" | "unavailable" | "none";

export interface FleetMachineHeat {
  readonly tier: FleetHeatTier;
  readonly status: FleetHeatStatus;
  readonly signals: FleetHeatSignals | null;
  readonly reasons: ReadonlyArray<string>;
  /** One line for a tooltip or label: what the PC is doing, or why there is nothing to show. */
  readonly summary: string;
}

/** Translated where shown: `t(FLEET_HEAT_LABEL[tier])`. */
export const FLEET_HEAT_LABEL: Readonly<Record<FleetHeatTier, string>> = {
  normal: "Normal",
  warm: "Warm",
  hot: "Running hot",
  burning: "Burning",
};

export const NO_FLEET_HEAT: FleetMachineHeat = { tier: "normal", status: "none", signals: null, reasons: [], summary: "No metrics" };

/** What one PC's host-status read gave: a live answer, the last one after it stopped answering, or nothing to show. */
export type FleetHostEntry =
  | { readonly reachability: "ok"; readonly metrics: HostStatus }
  | { readonly reachability: "unreachable"; readonly metrics?: HostStatus; readonly lastKnown?: true; readonly message?: string }
  | { readonly reachability: "unsupported" };

/** A PC's heat from its host-status entry and the tier it showed last. */
export function fleetMachineHeat(entry: FleetHostEntry | undefined, previous: FleetHeatTier = "normal"): FleetMachineHeat {
  if (entry === undefined) return { ...NO_FLEET_HEAT, summary: t("No metrics") };
  if (entry.reachability !== "ok") {
    const stale = entry.reachability === "unreachable" && entry.lastKnown === true && entry.metrics !== undefined;
    return { tier: "normal", status: stale ? "stale" : "unavailable", signals: null, reasons: [], summary: stale ? t("Metrics not live: host stopped answering") : t("Metrics unavailable") };
  }
  const signals = fleetHeatSignals(entry.metrics);
  const tier = fleetHeatTier(signals, previous);
  const reasons = fleetHeatReasons(signals);
  const context = (["cpu", "load", "memory"] as const).flatMap((key) => formatSignal(signals, key) ?? []);
  const summary = tier === "normal" ? context.join(" · ") || t("No metrics") : `${t(FLEET_HEAT_LABEL[tier])}: ${(reasons.length > 0 ? reasons : context).join(" · ")}`;
  return { tier, status: "live", signals, reasons, summary };
}
