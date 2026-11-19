import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { agentIdentity } from "../components/AgentMark.tsx";
import { classifyFleetPane, type FleetThreadState } from "./fleet.ts";
import { paneNumber } from "./paneNumber.ts";

/**
 * The agent map: every agent pane on every connected PC, idle ones included, grouped by
 * workspace (the user's project). The Fleet list counts only working panes, as GOAT does;
 * this map answers "which agent sits in which P of which project".
 */
export type FleetMapState = FleetThreadState | "idle";

export interface FleetMapPane {
  readonly key: string;
  readonly paneId: string;
  readonly number: string;
  /** the pane's own name; null when it would only repeat the agent's */
  readonly title: string | null;
  readonly agent: string;
  readonly agentLabel: string;
  readonly state: FleetMapState;
  /** OmO background tasks working for the pane */
  readonly subagents: number;
}

export interface FleetMapProject {
  readonly key: string;
  readonly number: number;
  readonly label: string;
  readonly panes: ReadonlyArray<FleetMapPane>;
}

export interface FleetMapMachine {
  readonly id: string;
  readonly label: string;
  readonly projects: ReadonlyArray<FleetMapProject>;
}

export function buildFleetMap(machines: ReadonlyArray<Machine>): FleetMapMachine[] {
  return machines.flatMap((machine) => {
    // an offline roster is a cache: only a connected PC shows its agents, as in the Fleet
    const snapshot = machine.state === "connected" ? machine.snapshot : null;
    if (!snapshot) return [];
    const panes = snapshot.panes as HerdrPane[];
    const projects = snapshot.workspaces
      .map((workspace): FleetMapProject => ({
        key: `${machine.id}:${workspace.workspace_id}`,
        number: workspace.number,
        label: workspace.label,
        panes: panes.filter((pane) => pane.workspace_id === workspace.workspace_id).flatMap((pane): FleetMapPane[] => {
          const reported = pane.agent || pane.display_agent;
          if (!reported) return [];
          const { agent, label } = agentIdentity(reported);
          const title = pane.label || pane.title || null;
          return [{ key: `${machine.id}:${pane.pane_id}`, paneId: pane.pane_id, number: paneNumber(pane), title: title === label ? null : title, agent, agentLabel: label, state: classifyFleetPane(pane) ?? "idle", subagents: Math.max(0, pane.background_tasks ?? 0) }];
        }),
      }))
      .filter((project) => project.panes.length > 0)
      .sort((a, b) => a.number - b.number);
    return projects.length === 0 ? [] : [{ id: machine.id, label: machine.name, projects }];
  });
}
