/**
 * A PC's connection as the Fleet shows it, ported from GOAT (packages/client-runtime/src/state/
 * fleetConnection.ts and fleetHostHealth.ts, apps/web/src/components/fleet/fleetConnection.ts;
 * MIT, see THIRD_PARTY_NOTICES.md). GOAT reads its Connections presentation; here a TermWeave
 * Machine's state says the same things: a bridge that answered but failed is `degraded`, a PC
 * that needs the user (a bridge update, a setup approval, an error) is `attention`.
 */
import type { Machine } from "../../shared/machines.ts";
import { t } from "./i18n.ts";

export type FleetConnectionState = "connected" | "connecting" | "reconnecting" | "degraded" | "unreachable" | "offline" | "attention" | "unknown";

export interface FleetConnection {
  readonly state: FleetConnectionState;
  /** the state's name, as the PC list says it */
  readonly label: string;
  /** the classified failure, when there is one */
  readonly reason: string | null;
  /** the step an attempt in progress has reached, such as "Installing the bridge" */
  readonly step?: string | null;
  /** when this client first saw the connection in this state (epoch ms), for elapsed time */
  readonly since?: number;
}

export const UNKNOWN_FLEET_CONNECTION: FleetConnection = Object.freeze({ state: "unknown", label: "Status unknown", reason: null });

/** What a PC's state means for the Fleet; `since` comes from fleetConnectionsSince. */
export function presentFleetConnection(machine: Pick<Machine, "state" | "error" | "enabled" | "snapshot" | "action_required" | "updating">): FleetConnection {
  const reason = machine.error || null;
  if (machine.updating) return { state: "connecting", label: t("Updating the bridge"), reason: null, step: machine.updating.step };
  if (machine.action_required) return { state: "attention", label: t("Action needed"), reason: reason ?? (machine.action_required === "update_bridge" ? t("Update the bridge to reconnect") : t("Approve setup to reconnect")) };
  switch (machine.state) {
    case "connected":
      // connected, its sessions not read yet: still on the way
      return machine.snapshot === null ? { state: "connecting", label: t("Connecting"), reason: null, step: t("Reading sessions") } : { state: "connected", label: t("Connected"), reason: null };
    case "connecting":
      return { state: "connecting", label: t("Connecting"), reason };
    case "reconnecting":
      // the PC answered but the attempt failed; it keeps retrying
      return reason !== null ? { state: "degraded", label: t("Degraded"), reason } : { state: "reconnecting", label: t("Reconnecting"), reason: null };
    case "error":
      return { state: "attention", label: t("Action needed"), reason };
    case "disconnected":
      return machine.enabled ? { state: "unreachable", label: t("Unreachable"), reason } : { state: "offline", label: t("Turned off"), reason: null };
    default:
      return UNKNOWN_FLEET_CONNECTION;
  }
}

/** In flight: the states that show elapsed time and turn slow after a while. */
export const isFleetConnectionWait = (state: FleetConnectionState) => state === "connecting" || state === "reconnecting";

/**
 * Each PC's connection with `since`: when this client first saw it in that state. A state that
 * holds keeps its time; a new one starts at `now`. The previous map comes back unchanged when
 * nothing moved, so a consumer keyed on it does not redraw.
 */
export function fleetConnectionsSince(machines: ReadonlyArray<Machine>, previous: ReadonlyMap<string, FleetConnection>, now: number): ReadonlyMap<string, FleetConnection> {
  let changed = previous.size !== machines.length;
  const next = new Map<string, FleetConnection>();
  for (const machine of machines) {
    const live = presentFleetConnection(machine);
    const held = previous.get(machine.id);
    const same = held !== undefined && held.state === live.state && held.label === live.label && held.reason === live.reason && (held.step ?? null) === (live.step ?? null);
    if (!same) changed = true;
    next.set(machine.id, same ? held : { ...live, since: held?.state === live.state ? held.since ?? now : now });
  }
  return changed ? next : previous;
}

/** A connection attempt this long stops reading as routine and offers a retry. */
export const SLOW_CONNECT_MS = 30_000;

/** "8s", "1m 12s", "3h 4m", "2d 3h". */
export function formatHealthDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m " + (seconds % 60) + "s";
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours + "h " + (minutes % 60) + "m";
  return Math.floor(hours / 24) + "d " + (hours % 24) + "h";
}

/** "Connecting · 12s · Installing the bridge", then "Still connecting · 1m 12s · …" once it is slow. */
export function presentConnectionWait(input: { readonly step: string | null; readonly sinceMs: number; readonly nowMs: number }): { readonly slow: boolean; readonly text: string } {
  const elapsed = Math.max(0, input.nowMs - input.sinceMs);
  const slow = elapsed >= SLOW_CONNECT_MS;
  return { slow, text: [slow ? t("Still connecting") : t("Connecting"), formatHealthDuration(elapsed), input.step].filter((part) => part !== null && part !== "").join(" · ") };
}

export type FleetConnectionTone = "success" | "warning" | "destructive" | "muted";
/** A shape that tells states apart without color. */
export type FleetConnectionShape = "dot" | "arc" | "half" | "ring" | "alert";

export interface FleetConnectionVisual {
  /** null leaves the node without a status mark */
  readonly glyph: FleetConnectionShape | null;
  readonly tone: FleetConnectionTone;
  /** null keeps the edge's usual look, which follows the PC's work */
  readonly edge: { readonly tone: Exclude<FleetConnectionTone, "success">; readonly dash: string; readonly animated: boolean } | null;
  /** draws the node muted, as the PC list does for PCs that are away */
  readonly quiet: boolean;
}

const VISUALS: Record<FleetConnectionState, FleetConnectionVisual> = {
  connected: { glyph: "dot", tone: "success", edge: null, quiet: false },
  connecting: { glyph: "arc", tone: "warning", edge: { tone: "warning", dash: "4 4", animated: true }, quiet: false },
  reconnecting: { glyph: "arc", tone: "warning", edge: { tone: "warning", dash: "4 4", animated: true }, quiet: false },
  degraded: { glyph: "half", tone: "warning", edge: { tone: "warning", dash: "8 3", animated: false }, quiet: false },
  unreachable: { glyph: "ring", tone: "muted", edge: { tone: "muted", dash: "1 5", animated: false }, quiet: true },
  offline: { glyph: "ring", tone: "muted", edge: { tone: "muted", dash: "1 5", animated: false }, quiet: true },
  attention: { glyph: "alert", tone: "destructive", edge: { tone: "destructive", dash: "3 5", animated: false }, quiet: false },
  unknown: { glyph: null, tone: "muted", edge: null, quiet: false },
};

export const fleetConnectionVisual = (state: FleetConnectionState): FleetConnectionVisual => VISUALS[state] ?? VISUALS.unknown;

/** The legend entries for the shapes the graph shows right now, in the order healthy, in flight, away, blocked. */
export function fleetConnectionLegend(connections: Iterable<FleetConnection>): ReadonlyArray<{ readonly state: FleetConnectionState; readonly label: string }> {
  const shown = new Set<FleetConnectionShape>();
  for (const connection of connections) {
    const { glyph } = fleetConnectionVisual(connection.state);
    if (glyph !== null) shown.add(glyph);
  }
  // unreachable and turned-off PCs share the quiet mark; each node's tooltip names which
  const legend: ReadonlyArray<{ readonly state: FleetConnectionState; readonly label: string }> = [
    { state: "connected", label: t("Connected") },
    { state: "reconnecting", label: t("Reconnecting") },
    { state: "degraded", label: t("Degraded") },
    { state: "unreachable", label: t("Not connected") },
    { state: "attention", label: t("Action needed") },
  ];
  return legend.filter((entry) => shown.has(fleetConnectionVisual(entry.state).glyph!));
}
