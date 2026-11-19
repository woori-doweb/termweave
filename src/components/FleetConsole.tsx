/**
 * Live fleet telemetry above the graph, ported from GOAT (apps/web/src/components/fleet/
 * FleetConsole.tsx, FleetAlertAction.tsx, FleetUncountedHosts.tsx; MIT, see
 * THIRD_PARTY_NOTICES.md): threads and the last hour, every PC's CPU, memory and load with
 * ten minutes of history, plan usage, and alerts with their one next step. Collapsing unmounts
 * the body and its sweep.
 */
import { ChevronDown } from "lucide-react";
import { memo, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { Machine } from "../../shared/machines.ts";
import { machineRequest } from "../lib/api.ts";
import type { FleetSnapshot } from "../lib/fleet.ts";
import { isFleetConnectionWait, presentConnectionWait, type FleetConnection } from "../lib/fleetConnection.ts";
import { cpuPercent, FLEET_HEAT_THRESHOLDS, memoryPercent, type FleetHeatTier } from "../lib/fleetHeat.ts";
import { fleetAlerts, fleetHostCount, fleetHostRows, fleetQuota, fleetThroughput, hottestHost, hottestReading, lastKnownLabel, observedFleetRuns, rowMetrics, subscribeFleetRuns, signalTier, sparklinePath, THROUGHPUT_BUCKETS, type FleetAlert, type FleetAlertActionKind, type FleetHostRow, type FleetThroughput, type FleetUncountedHost, type HostLastSeen, type HostSample } from "../lib/fleetTelemetry.ts";
import { t } from "../lib/i18n.ts";
import type { FleetTelemetry } from "../lib/useFleetTelemetry.ts";
import { FleetTip, placeNear } from "./FleetTip.tsx";

const COLLAPSED_KEY = "termweave.fleetConsoleCollapsed";
const LISTED = 8;

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
}
function writeCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0"); } catch { /* the choice holds for this visit only */ }
}

/** Ticks once a second while `active`, so waits show elapsed time and turn slow on time. */
function useNowWhile(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}

/** A reading colored on the graph's heat thresholds and palette; muted when the PC sent none. */
const tone = (key: keyof typeof FLEET_HEAT_THRESHOLDS, value: number | null): FleetHeatTier | "muted" => value === null ? "muted" : signalTier(key, value);

const Label = ({ children }: { readonly children: React.ReactNode }) => <span className="fleet-console-label">{children}</span>;

/** One series as one path. Re-renders only when a PC gets a new sample. */
const Sparkline = memo(function Sparkline(props: { readonly samples: ReadonlyArray<HostSample>; readonly field: "cpu" | "memory" | "load"; readonly max: number; readonly tone: FleetHeatTier | "muted" }) {
  const path = sparklinePath(props.samples.map((sample) => sample[props.field]), 100, 16, props.max);
  return (
    <svg aria-hidden="true" viewBox="0 0 100 16" preserveAspectRatio="none" className="fleet-spark" data-tone={props.tone}>
      <line x1="0" x2="100" y1="15.5" y2="15.5" className="fleet-console-baseline" />
      <path d={path} className="fleet-console-spark" vectorEffect="non-scaling-stroke" />
    </svg>
  );
});

const NO_SAMPLES: ReadonlyArray<HostSample> = [];
const PLATFORM: Readonly<Record<string, string>> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
const formatPercent = (value: number | null) => value === null ? "–" : Math.round(value) + "%";

/** Why a PC has no host status yet: its connection is not up, or an answer is on its way. */
function noMetricsText(connection: FleetConnection | undefined, reading: boolean, now: number): string {
  if (connection !== undefined && isFleetConnectionWait(connection.state) && connection.since !== undefined) return presentConnectionWait({ step: connection.step ?? null, sinceMs: connection.since, nowMs: now }).text;
  switch (connection?.state) {
    case "connecting": case "reconnecting": case "unreachable": case "offline": case "attention": return connection.label;
    default: return reading ? t("Reading…") : t("No metrics");
  }
}

/** "macmini · macOS · 10 cores", with how old the numbers are when the PC stopped answering. */
function hostDetail(row: FleetHostRow, lastSeen: HostLastSeen, now: number): string {
  const metrics = rowMetrics(row);
  const parts: Array<string | null> = [row.label, metrics === undefined ? null : PLATFORM[metrics.platform] ?? metrics.platform];
  if (metrics !== undefined) parts.push(t("{n} cores", { n: metrics.cpu_count }));
  parts.push(lastKnownLabel(row, lastSeen, now));
  if (row.tone === "none") parts.push(t("no host status describes this PC"));
  return parts.filter((part) => part !== null).join(" · ");
}

function HostRow({ row, samples, lastSeen, observedAt, heatTier, connection, reading, now, answeringLate }: {
  readonly row: FleetHostRow;
  readonly samples: ReadonlyArray<HostSample>;
  readonly lastSeen: HostLastSeen;
  readonly observedAt: number;
  /** the PC's tier as its node in the graph shows it */
  readonly heatTier: FleetHeatTier;
  readonly connection: FleetConnection | undefined;
  /** a read is still on its way, so a row without an answer may yet get one */
  readonly reading: boolean;
  readonly now: number;
  /** the PC is connected but not answering: its alert's tone */
  readonly answeringLate: FleetAlert["tone"] | null;
}) {
  const metrics = rowMetrics(row);
  const stale = row.tone === "stale";
  const statusText = row.tone === "none" ? noMetricsText(connection, reading, now) : row.tone === "unsupported" ? t("Update the bridge to report") : metrics === undefined ? t("Unreachable") : null;
  // the graph's rounded helpers, so a reading on a threshold gets the same color as the ring
  const cpu = metrics === undefined ? null : cpuPercent(metrics);
  const memory = metrics === undefined ? null : memoryPercent(metrics);
  const load = metrics?.load_avg?.one_minute ?? null;
  const cores = metrics?.cpu_count ?? 1;
  const loadMax = Math.max(cores, ...samples.map((sample) => sample.load ?? 0));
  const dot = row.tone === "ok" && answeringLate !== null ? answeringLate : row.tone === "ok" ? heatTier === "normal" ? "ok" : heatTier : row.tone === "stale" || row.tone === "unreachable" ? "warning" : "muted";
  return (
    <li className="fleet-host-row fleet-host-grid">
      <span className="fleet-host-name">
        <span aria-hidden="true" className="fleet-host-dot" data-tone={dot} />
        <FleetTip tip={hostDetail(row, lastSeen, observedAt)} className="fleet-host-label">{row.label}</FleetTip>
      </span>
      {statusText !== null ? <span className="fleet-host-status">{statusText}</span> : (
        <>
          <MetricCell value={formatPercent(cpu)} tone={tone("cpu", cpu)} stale={stale} samples={samples} field="cpu" max={100} />
          <MetricCell value={formatPercent(memory)} tone={tone("memory", memory)} stale={stale} samples={samples} field="memory" max={100} />
          <MetricCell value={load === null ? "–" : load.toFixed(load >= 10 ? 0 : 1)} tone={tone("load", load === null ? null : load / cores)} stale={stale} samples={samples} field="load" max={loadMax} />
        </>
      )}
    </li>
  );
}

function MetricCell(props: { readonly value: string; readonly tone: FleetHeatTier | "muted"; readonly stale: boolean; readonly samples: ReadonlyArray<HostSample>; readonly field: "cpu" | "memory" | "load"; readonly max: number }) {
  return (
    <span className="fleet-metric" data-stale={props.stale || undefined}>
      <Sparkline samples={props.samples} field={props.field} max={props.max} tone={props.tone} />
      <span className="fleet-metric-value" data-tone={props.tone}>{props.value}</span>
    </span>
  );
}

/** Started runs rise above the line, finished ones hang below: one path each. */
const ThroughputBars = memo(function ThroughputBars({ throughput }: { readonly throughput: FleetThroughput }) {
  const width = 120;
  const half = 14;
  const slot = width / THROUGHPUT_BUCKETS;
  const peak = Math.max(1, ...throughput.startedBuckets, ...throughput.finishedBuckets);
  const bars = (counts: ReadonlyArray<number>, direction: 1 | -1) => counts.map((count, index) => {
    if (count === 0) return "";
    const height = Math.max(1.5, (count / peak) * (half - 1));
    const x = (index * slot + 1).toFixed(2);
    const y = direction === 1 ? half - height : half + 1;
    return `M${x} ${y.toFixed(2)}h${(slot - 2).toFixed(2)}v${height.toFixed(2)}h-${(slot - 2).toFixed(2)}Z`;
  }).join("");
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${width} ${half * 2 + 1}`} preserveAspectRatio="none" className="fleet-throughput">
      <line x1="0" x2={width} y1={half + 0.5} y2={half + 0.5} className="fleet-console-baseline" />
      <path d={bars(throughput.startedBuckets, 1)} className="fleet-throughput-started" />
      <path d={bars(throughput.finishedBuckets, -1)} className="fleet-throughput-finished" />
    </svg>
  );
});

function Stat(props: { readonly label: string; readonly value: number; readonly dot: string }) {
  return (
    <div className="fleet-stat">
      <span aria-hidden="true" className="fleet-state-dot" data-state={props.dot} />
      <Label>{props.label}</Label>
      <span aria-hidden="true" className="fleet-console-leader" />
      <span className="fleet-stat-value">{props.value}</span>
    </div>
  );
}

/** "+N" beside a PC count: PCs on the page that the count leaves out, listed in its tooltip. */
export function FleetUncountedHosts(props: { readonly hosts: ReadonlyArray<FleetUncountedHost> }) {
  const { hosts } = props;
  if (hosts.length === 0) return null;
  const summary = hosts.length === 1 ? t("1 more PC shown, not counted") : t("{n} more PCs shown, not counted", { n: hosts.length });
  return (
    <FleetTip button className="fleet-count-chip" label={`${summary}: ${hosts.map((host) => `${host.label}, ${host.reason}`).join("; ")}`} tip={(
      <span className="fleet-tip-list">
        <strong>{t("Only PCs that answer are counted.")}</strong>
        {hosts.slice(0, LISTED).map((host) => <span key={host.key}>{host.label} <span className="fleet-tip-dim">· {host.reason}</span></span>)}
        {hosts.length > LISTED ? <span className="fleet-tip-dim">{t("and {n} more", { n: hosts.length - LISTED })}</span> : null}
      </span>
    )}>+{hosts.length}</FleetTip>
  );
}

/** An alert's one next step, run against the PC itself; "setup" opens the PC's setup dialog. */
function FleetAlertAction(props: { readonly kind: FleetAlertActionKind; readonly machine: Machine | undefined; readonly label: string; readonly onSetup: (machine: Machine) => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const { kind, machine } = props;
  if (machine === undefined) return null;
  const run = async (request: () => Promise<unknown>) => {
    setBusy(true); setFailed(null);
    try { await request(); } catch (error) { setFailed(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const text = kind === "retry" ? t("Retry") : kind === "update_bridge" ? t("Update bridge") : t("Set up…");
  const act = () => kind === "setup" ? props.onSetup(machine)
    : void run(() => kind === "retry" ? machineRequest(`/${encodeURIComponent(machine.id)}`, "PATCH", { enabled: true }) : machineRequest(`/${encodeURIComponent(machine.id)}/update-bridge`, "POST"));
  return (
    <span className="fleet-alert-action">
      <button type="button" className="btn btn-compact" disabled={busy} aria-label={`${text}: ${props.label}`} onClick={act}>{text}</button>
      {failed !== null ? <span role="alert" className="fleet-alert-failed">{failed}</span> : null}
    </span>
  );
}

/** One alert: what is wrong, where, and its one next step. Long details clamp to two lines. */
function AlertRow({ alert, machines, onSetup }: { readonly alert: FleetAlert; readonly machines: ReadonlyMap<string, Machine>; readonly onSetup: (machine: Machine) => void }) {
  return (
    <li data-fleet-alert="" className="fleet-alert">
      <span aria-hidden="true" className="fleet-alert-dot" data-tone={alert.tone} />
      <FleetTip className="fleet-alert-text" tip={<span className="fleet-tip-list"><span>{alert.detail}</span>{alert.lines?.map((line) => <span key={line} className="fleet-tip-dim">{line}</span>)}</span>}>
        <strong>{alert.label}</strong> <span>{alert.detail}</span>
      </FleetTip>
      {alert.action === undefined ? null : <FleetAlertAction kind={alert.action.kind} machine={machines.get(alert.action.machineId)} label={alert.label} onSetup={onSetup} />}
    </li>
  );
}

/** "+N more": the rest of the alerts in a popover over the button, closed by Escape or a click outside. */
function MoreAlerts({ alerts, machines, onSetup }: { readonly alerts: ReadonlyArray<FleetAlert>; readonly machines: ReadonlyMap<string, Machine>; readonly onSetup: (machine: Machine) => void }) {
  const id = useId();
  const popover = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const toggle = () => {
    const pop = popover.current;
    if (pop === null || button.current === null) return;
    try { pop.togglePopover(); } catch { return; }
    if (pop.matches(":popover-open")) placeNear(pop, button.current);
  };
  return (
    <li>
      <button ref={button} type="button" className="fleet-more-alerts" aria-controls={id} onClick={toggle}>{t("+{n} more", { n: alerts.length })}</button>
      <div ref={popover} id={id} popover="auto" className="fleet-tip fleet-alert-popover">
        <ul aria-label={t("More alerts")} className="fleet-alert-list">
          {alerts.map((alert) => <AlertRow key={alert.key} alert={alert} machines={machines} onSetup={onSetup} />)}
        </ul>
      </div>
    </li>
  );
}

function ConsoleHeader(props: { readonly collapsed: boolean; readonly onToggle: () => void; readonly children?: React.ReactNode }) {
  return (
    <header className="fleet-console-header" data-collapsed={props.collapsed || undefined}>
      <span className="fleet-console-title">
        <span aria-hidden="true" className="fleet-console-mark" />
        <h3>{t("Fleet telemetry")}</h3>
      </span>
      {props.children}
      <button type="button" className="icon-button fleet-console-toggle" aria-expanded={!props.collapsed} aria-label={props.collapsed ? t("Expand fleet telemetry") : t("Collapse fleet telemetry")} onClick={props.onToggle}>
        <ChevronDown aria-hidden="true" data-open={!props.collapsed || undefined} />
      </button>
    </header>
  );
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function FleetConsoleExpanded(props: {
  readonly snapshot: FleetSnapshot;
  readonly machines: ReadonlyArray<Machine>;
  readonly connections: ReadonlyMap<string, FleetConnection>;
  readonly telemetry: FleetTelemetry;
  readonly reduced: boolean;
  readonly onCollapse: () => void;
  readonly onSetup: (machine: Machine) => void;
}) {
  const { snapshot, connections, telemetry: status, reduced } = props;
  const rows = fleetHostRows(snapshot.machines, status.reports);
  const machinesById = new Map(props.machines.map((machine) => [machine.id, machine]));
  // ticks only while something is in progress, so waits show elapsed time and turn slow on time
  const inProgress = status.pendingSince.size > 0 || [...connections.values()].some((connection) => isFleetConnectionWait(connection.state));
  const now = Math.max(useNowWhile(inProgress), status.observedAt);
  const alerts = fleetAlerts(rows, connections, now, { lastSeen: status.lastSeen, pendingSince: status.pendingSince, actions: new Map(props.machines.map((machine) => [machine.id, machine.action_required ?? null])) });
  // a PC that is not answering takes its alert's color on the row, so both say the same
  const answeringLate = new Map(alerts.flatMap((alert) => alert.key.endsWith(":responsive") ? [[alert.key.slice(0, -":responsive".length), alert.tone] as const] : []));
  const hottest = hottestHost(rows, status.heat);
  const quota = fleetQuota(rows);
  const quotas = quota.slice(0, 3);
  const hiddenQuotas = quota.slice(quotas.length);
  const runs = useSyncExternalStore(subscribeFleetRuns, observedFleetRuns);
  const throughput = fleetThroughput(runs, now);
  const { totals } = snapshot;
  const hostCount = fleetHostCount(rows, snapshot.machines, connections);

  return (
    <>
      <ConsoleHeader collapsed={false} onToggle={props.onCollapse}>
        {hottest === null ? null : (
          <span className="fleet-console-meta fleet-console-hottest">
            <Label>{t("Hottest")}</Label>
            <span className="fleet-console-meta-name">{hottest.row.label}</span>
            <span className="fleet-metric-value" data-tone={hottest.tier}>{hottestReading(hottest)}</span>
          </span>
        )}
        {status.sampledAt > 0 ? (
          <span className="fleet-console-meta fleet-console-sampled">
            <Label>{t("Sampled")}</Label>
            <span className="fleet-console-clock">{clock.format(status.sampledAt)}</span>
          </span>
        ) : null}
      </ConsoleHeader>
      {/* stacked when narrow; threads and status over hosts; three columns once hosts get room */}
      <div className="fleet-console-body">
        {reduced || status.sampledAt === 0 ? null : <span key={status.sampledAt} aria-hidden="true" className="fleet-console-sweep" />}

        <section aria-label={t("Work")} className="fleet-console-threads">
          <div className="fleet-stats">
            <Stat label={t("Running")} value={totals.running} dot="running" />
            <Stat label={t("Need you")} value={totals.attention} dot="attention" />
            <Stat label={t("Done")} value={totals.reported} dot="reported" />
          </div>
          <div className="fleet-console-hour">
            <div className="fleet-console-hour-head">
              <Label>{t("1h")}</Label>
              <span className="fleet-console-hour-counts"><span data-tone="info">{throughput.started}</span> {t("started")} · <span data-tone="success">{throughput.finished}</span> {t("finished")}</span>
            </div>
            <ThroughputBars throughput={throughput} />
          </div>
        </section>

        <section aria-label={t("Hosts")} className="fleet-console-hosts">
          <div className="fleet-host-grid fleet-host-head">
            <span className="fleet-host-name"><Label>{t("Hosts {reporting}/{machines}", { reporting: hostCount.reporting, machines: totals.machines })}</Label><FleetUncountedHosts hosts={hostCount.uncounted} /></span>
            <Label>{t("CPU")}</Label>
            <Label>{t("Mem")}</Label>
            <Label>{t("Load 1m")}</Label>
          </div>
          {rows.length === 0 && status.loading ? <p className="fleet-console-note">{t("Reading hosts…")}</p> : (
            <ul className="fleet-host-list">
              {rows.map((row) => (
                <HostRow key={row.key} row={row} lastSeen={status.lastSeen} heatTier={status.heat.get(row.machineId)?.tier ?? "normal"}
                  connection={connections.get(row.machineId)} reading={status.loading || status.pendingSince.has(row.machineId)} observedAt={status.observedAt} now={now}
                  answeringLate={answeringLate.get(row.key) ?? null} samples={status.history.get(row.key) ?? NO_SAMPLES} />
              ))}
            </ul>
          )}
        </section>

        <section aria-label={t("Status")} className="fleet-console-status">
          {quotas.length > 0 ? (
            <div className="fleet-quota">
              <span className="fleet-quota-head">
                <Label>{t("Quota")}</Label>
                {hiddenQuotas.length > 0 ? (
                  <FleetTip className="fleet-console-note" label={t("Show {n} more quota entries", { n: hiddenQuotas.length })}
                    tip={<span className="fleet-tip-pre">{hiddenQuotas.map((row) => row.detail ?? `${row.label}${row.host === null ? "" : ` · ${row.host}`} ${row.windows.map((window) => `${window.label} ${Math.round(window.usedPercent)}%`).join(" · ")}`).join("\n")}</span>}>
                    {t("+{n} more", { n: hiddenQuotas.length })}
                  </FleetTip>
                ) : null}
              </span>
              {quotas.map((row) => (
                <div key={row.key} data-fleet-quota="" className="fleet-quota-row">
                  <span className="fleet-quota-line">
                    <span className="fleet-quota-name">{row.label}{row.host === null ? null : <span className="fleet-tip-dim"> · {row.host}</span>}</span>
                    <span className="fleet-quota-windows">
                      {row.windows.map((window) => `${window.label} ${Math.round(window.usedPercent)}%`).join(" · ")}
                      {row.hidden > 0 ? <FleetTip label={t("Show {n} more quota details", { n: row.hidden })} tip={<span className="fleet-tip-pre">{row.detail}</span>}>{` +${row.hidden}`}</FleetTip> : null}
                    </span>
                  </span>
                  <span className="fleet-quota-meter" role="meter" aria-label={t("{name} quota used", { name: row.label })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(row.peak)}>
                    <span data-tone={tone("quota", row.peak)} style={{ width: `${Math.max(2, row.peak)}%` }} />
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="fleet-alerts">
            <Label>{t("Alerts")} {alerts.length > 0 ? alerts.length : null}</Label>
            {alerts.length === 0 ? <span className="fleet-console-note">{t("All clear")}</span> : (
              <ul className="fleet-alert-list">
                {alerts.slice(0, 3).map((alert) => <AlertRow key={alert.key} alert={alert} machines={machinesById} onSetup={props.onSetup} />)}
                {alerts.length > 3 ? <MoreAlerts alerts={alerts.slice(3)} machines={machinesById} onSetup={props.onSetup} /> : null}
              </ul>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

export function FleetConsole(props: {
  readonly snapshot: FleetSnapshot;
  readonly machines: ReadonlyArray<Machine>;
  readonly connections: ReadonlyMap<string, FleetConnection>;
  readonly telemetry: FleetTelemetry;
  readonly reduced: boolean;
  readonly onSetup: (machine: Machine) => void;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (next: boolean) => { setCollapsed(next); writeCollapsed(next); };
  const { totals } = props.snapshot;
  return (
    <section aria-label={t("Fleet telemetry")} data-collapsed={collapsed || undefined} className="fleet-console">
      {collapsed ? (
        <ConsoleHeader collapsed onToggle={() => toggle(false)}>
          <span className="fleet-console-summary">{t("{running} running · {attention} need you · {reported} done", { running: totals.running, attention: totals.attention, reported: totals.reported })}</span>
        </ConsoleHeader>
      ) : (
        <FleetConsoleExpanded snapshot={props.snapshot} machines={props.machines} connections={props.connections} telemetry={props.telemetry} reduced={props.reduced} onCollapse={() => toggle(true)} onSetup={props.onSetup} />
      )}
    </section>
  );
}

