import { useEffect, useRef, useState } from "react";
import type { HostStatus } from "../../shared/hostStatus.ts";
import { machinePath, type Machine } from "../../shared/machines.ts";
import { fetchPaneOmoActivity } from "./api.ts";
import type { FleetSubagent, FleetThread } from "./fleet.ts";
import { fleetMachineHeat, type FleetHeatTier, type FleetHostEntry, type FleetMachineHeat } from "./fleetHeat.ts";
import { recordHostSamples, recordLastSeen, type HostHistory, type HostLastSeen, type HostReports } from "./fleetTelemetry.ts";
import { usePageVisible } from "./visibility.ts";

/** GOAT samples host status every 15 s while its Fleet page is open. */
const SAMPLE_MS = 15_000;

export interface FleetTelemetry {
  readonly reports: HostReports;
  readonly history: HostHistory;
  readonly lastSeen: HostLastSeen;
  readonly heat: ReadonlyMap<string, FleetMachineHeat>;
  /** reads still on their way, by machine id and when they started */
  readonly pendingSince: ReadonlyMap<string, number>;
  /** the newest sample's time; 0 before any */
  readonly sampledAt: number;
  /** when this client last took in a read */
  readonly observedAt: number;
  /** the first round of reads has not finished */
  readonly loading: boolean;
  /** each pane's OmO background tasks still running, by thread key */
  readonly subagents: ReadonlyMap<string, ReadonlyArray<FleetSubagent>>;
}

async function readHost(machineId: string, previous: FleetHostEntry | undefined): Promise<FleetHostEntry> {
  const lastKnown = previous === undefined || previous.reachability === "unsupported" ? undefined : previous.metrics;
  try {
    const response = await fetch(machinePath(machineId, "host-status"), { signal: AbortSignal.timeout(SAMPLE_MS) });
    // a bridge from before host status has no such route
    if (response.status === 404) return { reachability: "unsupported" };
    if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${response.status}`);
    return { reachability: "ok", metrics: await response.json() as HostStatus };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return lastKnown === undefined ? { reachability: "unreachable", message } : { reachability: "unreachable", metrics: lastKnown, lastKnown: true, message };
  }
}

/** What a PC that is not connected keeps: its last reading, as last known, or nothing. */
function offline(previous: FleetHostEntry | undefined): FleetHostEntry | undefined {
  if (previous === undefined || previous.reachability === "unsupported" || previous.metrics === undefined) return undefined;
  return { reachability: "unreachable", metrics: previous.metrics, lastKnown: true };
}

async function readSubagents(thread: FleetThread): Promise<ReadonlyArray<FleetSubagent>> {
  const { tasks } = await fetchPaneOmoActivity(thread.paneId, thread.machineId);
  return tasks.filter((task) => task.status === "running").map((task) => ({ key: task.id, title: task.title, status: "running" as const }));
}

/**
 * The Fleet page's host reads: every connected PC's host status every 15 s while the page is
 * open and the tab is visible, with each PC's sparkline history, last answer, and heat (held with
 * hysteresis from its previous tier), as GOAT's fleetHostMetrics and console telemetry atoms keep them.
 */
export function useFleetTelemetry(machines: ReadonlyArray<Machine>, threads: ReadonlyArray<FleetThread>): FleetTelemetry {
  const visible = usePageVisible();
  const latest = useRef({ machines, threads });
  latest.current = { machines, threads };
  const tiers = useRef(new Map<string, FleetHeatTier>());
  const [state, setState] = useState<FleetTelemetry>(() => ({ reports: new Map(), history: new Map(), lastSeen: new Map(), heat: new Map(), pendingSince: new Map(), sampledAt: 0, observedAt: 0, loading: true, subagents: new Map() }));
  const reports = useRef<HostReports>(state.reports);
  const arrived = useRef<() => void>(() => {});

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const pending = new Map<string, number>();
    /** Takes in each PC's new entry (undefined forgets it) and moves everything read from them along. */
    const apply = (changes: ReadonlyMap<string, FleetHostEntry | undefined>, read: boolean) => setState((current) => {
      const now = Date.now();
      const next = new Map(reports.current);
      const heat = new Map(current.heat);
      let sampledAt = current.sampledAt;
      for (const [machineId, entry] of changes) {
        if (entry === undefined) { next.delete(machineId); heat.delete(machineId); tiers.current.delete(machineId); continue; }
        next.set(machineId, entry);
        const reading = fleetMachineHeat(entry, tiers.current.get(machineId));
        tiers.current.set(machineId, reading.tier);
        heat.set(machineId, reading);
        if (entry.reachability === "ok") sampledAt = Math.max(sampledAt, entry.metrics.sampled_at);
      }
      reports.current = next;
      return {
        ...current, reports: next, heat, sampledAt, pendingSince: new Map(pending),
        history: recordHostSamples(current.history, next, now), lastSeen: recordLastSeen(current.lastSeen, next, now),
        observedAt: read ? now : current.observedAt, loading: current.loading && pending.size > 0,
      };
    });
    /** Reads every connected PC `only` picks, unless a read of it is still on its way. */
    const read = (only: (machineId: string) => boolean) => {
      for (const machine of latest.current.machines) {
        if (machine.state !== "connected" || pending.has(machine.id) || !only(machine.id)) continue;
        pending.set(machine.id, Date.now());
        void readHost(machine.id, reports.current.get(machine.id)).then((entry) => {
          if (cancelled) return;
          pending.delete(machine.id);
          apply(new Map([[machine.id, entry]]), true);
        });
      }
    };
    let taskPanes = "";
    const readTasks = () => {
      const busy = latest.current.threads.filter((thread) => thread.backgroundTasks > 0);
      taskPanes = busy.map((thread) => thread.key).join("\n");
      void Promise.all(busy.map(async (thread) => [thread.key, await readSubagents(thread).catch(() => [])] as const))
        .then((entries) => { if (!cancelled) setState((current) => ({ ...current, subagents: new Map(entries) })); });
    };
    const tick = () => {
      const { machines: now } = latest.current;
      const changes = new Map<string, FleetHostEntry | undefined>();
      for (const id of reports.current.keys()) if (!now.some((machine) => machine.id === id)) changes.set(id, undefined);
      for (const machine of now) if (machine.state !== "connected" && reports.current.has(machine.id)) changes.set(machine.id, offline(reports.current.get(machine.id)));
      read(() => true);
      apply(changes, false);
      readTasks();
    };
    // a PC that connects (or the roster that arrives after the page opened) is read at once, not at the next tick
    arrived.current = () => {
      read((machineId) => !reports.current.has(machineId));
      if (latest.current.threads.filter((thread) => thread.backgroundTasks > 0).map((thread) => thread.key).join("\n") !== taskPanes) readTasks();
    };
    tick();
    const timer = setInterval(tick, SAMPLE_MS);
    return () => { cancelled = true; clearInterval(timer); arrived.current = () => {}; };
  }, [visible]);
  useEffect(() => arrived.current(), [machines]);

  return state;
}
