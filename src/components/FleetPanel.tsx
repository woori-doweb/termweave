/**
 * The Fleet page, ported from GOAT (apps/web/src/components/fleet/FleetPage.tsx,
 * FleetThreadList.tsx, FleetSubagents.tsx; MIT, see THIRD_PARTY_NOTICES.md): telemetry, the
 * orbit graph with its legend, then what runs on each PC, grouped by PC, and the connections.
 * GOAT's page is a route; TermWeave's is a full-window dialog over the app, and a row opens its
 * pane where GOAT's opens a thread.
 */
import { Settings, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LOCAL_MACHINE, type Machine } from "../../shared/machines.ts";
import { buildFleet, fleetMachineSubtitle, isFleetMachineBusy, type FleetMachine, type FleetSubagent, type FleetThread } from "../lib/fleet.ts";
import { fleetConnectionLegend, fleetConnectionsSince, isFleetConnectionWait, UNKNOWN_FLEET_CONNECTION, type FleetConnection } from "../lib/fleetConnection.ts";
import { FLEET_HEAT_LABEL, FLEET_HEAT_TIERS } from "../lib/fleetHeat.ts";
import { fleetUncountedMachines, slowConnectionWaits } from "../lib/fleetTelemetry.ts";
import { t, useLocale } from "../lib/i18n.ts";
import { useFleetTelemetry } from "../lib/useFleetTelemetry.ts";
import { AgentMark } from "./AgentMark.tsx";
import { FleetConnectionGlyph, FleetConnectionIcon, FleetGraph } from "./FleetGraph.tsx";
import { FleetConsole, FleetUncountedHosts } from "./FleetConsole.tsx";
import { FleetMap } from "./FleetMap.tsx";
import { FleetTip } from "./FleetTip.tsx";
import "./FleetPanel.css";

/** Translated where shown: `t(STATE_LABEL[state])`. */
export const STATE_LABEL: Readonly<Record<FleetThread["state"], string>> = {
  running: "Running",
  attention: "Needs you",
  reported: "Done",
};

const LISTED = 8;
const SUBAGENT_STATUS: Readonly<Record<FleetSubagent["status"], string>> = {
  pending: "Starting",
  running: "Running",
  waiting: "Waiting",
};

interface Props {
  readonly machines: ReadonlyArray<Machine>;
  readonly onClose: () => void;
  readonly onOpen: (machineId: string, paneId: string) => void;
  /** opens a PC's setup dialog, for an alert whose next step is approving setup */
  readonly onSetup: (machine: Machine) => void;
  /** opens Settings at Remote PCs, where PCs are added and managed */
  readonly onConnections: () => void;
}

function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** Each PC's connection, with when this client first saw it in that state; ticks every 5 s while one waits. */
function useConnections(machines: ReadonlyArray<Machine>): { readonly connections: ReadonlyMap<string, FleetConnection>; readonly now: number } {
  const [connections, setConnections] = useState<ReadonlyMap<string, FleetConnection>>(() => fleetConnectionsSince(machines, new Map(), Date.now()));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setConnections((previous) => fleetConnectionsSince(machines, previous, Date.now())), [machines]);
  // a coarse check while an attempt has not yet turned slow; nothing ticks once nothing waits
  const waiting = [...connections.values()].some((connection) => isFleetConnectionWait(connection.state));
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [waiting]);
  return { connections, now };
}

const groupThreadsByMachine = (threads: ReadonlyArray<FleetThread>) => {
  const grouped = new Map<string, FleetThread[]>();
  for (const thread of threads) grouped.set(thread.machineId, [...grouped.get(thread.machineId) ?? [], thread]);
  return grouped;
};

/** Everything running across connected PCs, as a graph and a list grouped by PC. */
export function FleetPanel({ machines, onClose, onOpen, onSetup, onConnections }: Props) {
  const id = useId();
  const locale = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const surface = dialog.current; surface?.showModal();
    return () => { surface?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);

  const reduced = useReducedMotion();
  const first = buildFleet(machines);
  const telemetry = useFleetTelemetry(machines, first.threads);
  const hosts = new Map([...telemetry.reports].flatMap(([machineId, entry]) => entry.reachability === "ok" ? [[machineId, entry.metrics] as const] : entry.reachability === "unreachable" && entry.metrics ? [[machineId, entry.metrics] as const] : []));
  const snapshot = buildFleet(machines, hosts);
  const { connections, now } = useConnections(machines);
  const slowMachineIds = slowConnectionWaits(connections, now);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedMachine = snapshot.machines.find((machine) => machine.id === selected) ?? null;
  const toggleMachine = (machineId: string) => setSelected((current) => current === machineId ? null : machineId);
  const threadsByMachine = groupThreadsByMachine(snapshot.threads);
  const listed = (selectedMachine ? [selectedMachine] : snapshot.machines).filter(isFleetMachineBusy);
  // a PC that is away or blocked is not idle; its row under Connections says why
  const reachable = (machine: FleetMachine) => { const { state } = connections.get(machine.id) ?? UNKNOWN_FLEET_CONNECTION; return state === "connected" || state === "unknown"; };
  const idle = selectedMachine ? [] : snapshot.machines.filter((machine) => !isFleetMachineBusy(machine) && reachable(machine));
  const connectionLegend = fleetConnectionLegend(connections.values());
  const heatLegend = FLEET_HEAT_TIERS.filter((tier) => tier !== "normal" && [...telemetry.heat.values()].some((entry) => entry.tier === tier));
  const { totals } = snapshot;
  const uncounted = fleetUncountedMachines(snapshot.machines, connections);
  const open = (thread: FleetThread) => { onOpen(thread.machineId, thread.paneId); onClose(); };

  return createPortal(
    <dialog ref={dialog} className="fleet-dialog" lang={locale} aria-labelledby={`${id}-title`} onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <header className="fleet-header">
        <h2 id={`${id}-title`}>{t("Agent fleet")}</h2>
        <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose} autoFocus><X aria-hidden="true" /></button>
      </header>
      <main className="fleet-body">
        <FleetConsole snapshot={snapshot} machines={machines} connections={connections} telemetry={telemetry} reduced={reduced} onSetup={(machine) => { onClose(); onSetup(machine); }} />
        <p className="fleet-status" role="status">
          {totals.running + totals.attention === 0
            ? (totals.machines === 1 ? t("Nothing running on 1 PC") : t("Nothing running on {n} PCs", { n: totals.machines }))
            : t("{running} running, {attention} need you, on {machines} PCs", { running: totals.running, attention: totals.attention, machines: totals.machines })}
          {uncounted.length > 0 ? " " : null}
          <FleetUncountedHosts hosts={uncounted} />.
          {totals.reported > 0 ? " " + t("{n} done, waiting to be read.", { n: totals.reported }) : null}
          {telemetry.loading && machines.some((machine) => machine.state === "connected") ? " " + t("Reading host status…") : null}
        </p>
        <FleetMap machines={selectedMachine ? machines.filter((machine) => machine.id === selectedMachine.id) : machines} onOpen={(machineId, paneId) => { onOpen(machineId, paneId); onClose(); }} />
        <section aria-label={t("Fleet graph")} className="fleet-graph-card">
          <FleetGraph snapshot={snapshot} connections={connections} currentMachineId={LOCAL_MACHINE} selectedMachineId={selected} onSelectMachine={toggleMachine} heat={telemetry.heat} slowMachineIds={slowMachineIds} />
          <div className="fleet-legend">
            {(["running", "attention", "reported"] as const).map((state) => (
              <span key={state} className="fleet-legend-item"><span aria-hidden="true" className="fleet-state-dot" data-state={state} />{t(STATE_LABEL[state])}</span>
            ))}
            {connectionLegend.length > 0 ? <span aria-hidden="true" className="fleet-legend-rule" /> : null}
            {connectionLegend.map((entry) => <span key={entry.label} className="fleet-legend-item"><FleetConnectionIcon state={entry.state} />{entry.label}</span>)}
            {heatLegend.length > 0 ? <span aria-hidden="true" className="fleet-legend-rule" /> : null}
            {heatLegend.map((tier) => <span key={tier} className="fleet-legend-item"><span aria-hidden="true" className="fleet-heat-dot" data-tier={tier} />{t(FLEET_HEAT_LABEL[tier])}</span>)}
            <span className="fleet-legend-hint">{t("Select a PC to show only its agents.")}</span>
          </div>
        </section>

        {selectedMachine ? (
          <div className="fleet-filter">
            <span>{t("Showing {name}", { name: selectedMachine.label })}</span>
            <button type="button" className="btn btn-compact" onClick={() => setSelected(null)}>{t("Show all")}</button>
          </div>
        ) : null}

        {listed.map((machine) => {
          const subtitle = fleetMachineSubtitle(machine);
          return (
            <section key={machine.id} aria-label={machine.label} className="fleet-machine-section">
              <button type="button" aria-pressed={selected === machine.id} onClick={() => toggleMachine(machine.id)} className="fleet-machine-head">
                <span className="fleet-machine-head-name">{machine.label}</span>
                {subtitle !== null ? <span className="fleet-machine-head-sub">{subtitle}</span> : null}
                <span className="fleet-machine-head-work">{fleetMachineWork(machine)}</span>
              </button>
              <FleetThreadList threads={threadsByMachine.get(machine.id) ?? []} subagents={telemetry.subagents} onOpen={open} />
            </section>
          );
        })}

        {idle.length > 0 ? <p className="fleet-idle">{t("Idle: {names}", { names: idle.map((machine) => machine.label).join(", ") })}</p> : null}
        {selectedMachine && listed.length === 0 ? <p className="fleet-empty">{t("Nothing running on this PC.")}</p> : null}
        {machines.length === 0 ? <p className="fleet-empty">{t("No PCs are connected yet.")}</p> : null}

        <section aria-labelledby={`${id}-connections`} className="fleet-connections">
          <div className="fleet-connections-head">
            <h3 id={`${id}-connections`}>{t("Connections")}</h3>
            <FleetTip button className="icon-button fleet-connections-settings" label={t("Connection settings")} tip={t("Connection settings")} onClick={() => { onClose(); onConnections(); }}>
              <Settings aria-hidden="true" />
            </FleetTip>
          </div>
          <ul className="fleet-connection-list">
            {snapshot.machines.map((machine) => {
              const connection = connections.get(machine.id) ?? UNKNOWN_FLEET_CONNECTION;
              const subtitle = machine.id === LOCAL_MACHINE ? t("This PC") : fleetMachineSubtitle(machine);
              return (
                <li key={machine.id} className="fleet-connection">
                  <svg aria-hidden="true" viewBox="-6 -6 12 12" className="fleet-connection-glyph"><FleetConnectionGlyph state={connection.state} /></svg>
                  <span className="fleet-connection-name">{machine.label}{subtitle !== null ? <small>{subtitle}</small> : null}</span>
                  <span className="fleet-connection-state">{connection.label}{connection.reason !== null ? <small>{connection.reason}</small> : null}</span>
                </li>
              );
            })}
          </ul>
        </section>
      </main>
    </dialog>,
    document.body,
  );
}

/** "2 running · 1 need you", or "Idle" when nothing runs there. */
function fleetMachineWork(machine: FleetMachine): string {
  const parts = [
    machine.running > 0 ? t("{n} running", { n: machine.running }) : null,
    machine.attention > 0 ? t("{n} need you", { n: machine.attention }) : null,
    machine.reported > 0 ? t("{n} done", { n: machine.reported }) : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? t("Idle") : parts.join(" · ");
}

/** One PC's work, in pane order, so rows hold still while statuses change. */
function FleetThreadList({ threads, subagents, onOpen }: { readonly threads: ReadonlyArray<FleetThread>; readonly subagents: ReadonlyMap<string, ReadonlyArray<FleetSubagent>>; readonly onOpen: (thread: FleetThread) => void }) {
  return (
    <ul className="fleet-thread-list">
      {threads.map((thread) => (
        <li key={thread.key} className="fleet-thread" data-state={thread.state}>
          <span aria-hidden="true" className="fleet-state-dot" data-state={thread.state} />
          {/* the button stretches over the row, so the subagent chip can be its own button beside the title */}
          <span className="fleet-thread-title">
            <button type="button" className="fleet-thread-open" onClick={() => onOpen(thread)}>
              <span className="fleet-thread-number">{thread.number}</span> {thread.title}
            </button>
            {thread.workspace ? <small>{thread.workspace}</small> : null}
            <FleetSubagents subagents={subagents.get(thread.key) ?? []} count={thread.backgroundTasks} />
          </span>
          <span className="fleet-thread-agent"><AgentMark agent={thread.agentDriver} size={14} />{thread.agentLabel}</span>
          <span className="fleet-thread-state">{t(STATE_LABEL[thread.state])}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * "+N" on a pane's row: OmO background tasks working in its session. They share the pane's
 * agent and its limits, so they stay on its row instead of adding rows. The count is the
 * server's; the titles come from the pane's task list once it is read.
 */
function FleetSubagents({ subagents, count }: { readonly subagents: ReadonlyArray<FleetSubagent>; readonly count: number }) {
  const total = Math.max(count, subagents.length);
  if (total === 0) return null;
  const summary = total === 1 ? t("1 subagent") : t("{n} subagents", { n: total });
  return (
    <FleetTip button className="fleet-count-chip" label={`${summary}: ${subagents.map((subagent) => `${subagent.title}, ${t(SUBAGENT_STATUS[subagent.status])}`).join("; ")}`} tip={(
      <span className="fleet-tip-list">
        <strong>{t("{summary} working in this pane", { summary })}</strong>
        {subagents.slice(0, LISTED).map((subagent) => (
          <span key={subagent.key} className="fleet-tip-row"><span aria-hidden="true" className="fleet-state-dot" data-state={subagent.status === "running" ? "running" : "idle"} />{subagent.title}<span className="fleet-tip-dim">· {t(SUBAGENT_STATUS[subagent.status])}</span></span>
        ))}
        {subagents.length > LISTED ? <span className="fleet-tip-dim">{t("and {n} more", { n: subagents.length - LISTED })}</span> : null}
      </span>
    )}>+{total}</FleetTip>
  );
}

