import type { HostMachineKind, HostStatus } from "../../shared/hostStatus.ts";
import { LOCAL_MACHINE, type Machine, type MachineState } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { agentIdentity } from "../components/AgentMark.tsx";
import type { FleetWork, LayoutMachineInput } from "./fleetLayout.ts";
import { t } from "./i18n.ts";
import { paneNumber } from "./paneNumber.ts";

/**
 * Fleet: what is running right now on every PC, as GOAT's /fleet page builds it
 * (packages/client-runtime/src/state/fleet.ts, MIT; see THIRD_PARTY_NOTICES.md) with a herdr
 * pane in place of a GOAT thread and an agent kind (Claude Code, Codex…) in place of a provider.
 *
 * A pane counts while its agent works or holds background tasks open (running), or waits on
 * the user (attention). A finished turn the user has not read yet is `reported`: the agent told
 * the pane it is done. Idle agents and plain shells are not in the Fleet, as in GOAT.
 */
export type FleetThreadState = "running" | "attention" | "reported";

export interface FleetAgent extends FleetWork {
  /** the agent kind, as AgentMark knows it */
  readonly key: string;
  readonly label: string;
  /** AgentMark's name for its logo */
  readonly driver: string;
}

export type FleetMachineKind = "environment" | "ssh";
export type FleetMachineOs = "darwin" | "linux" | "windows";

export interface FleetMachine extends LayoutMachineInput {
  readonly label: string;
  readonly subtitle: string | null;
  /** `environment` is the PC this web server runs on; `ssh` a PC it reaches through a bridge */
  readonly kind: FleetMachineKind;
  /** host OS and hardware shape, from the PC's host status once it answers */
  readonly os: FleetMachineOs | null;
  readonly machineKind: HostMachineKind | null;
  /** connected and serving its sessions: only these count, as GOAT counts answering servers */
  readonly answering: boolean;
  readonly state: MachineState;
  readonly agents: ReadonlyArray<FleetAgent>;
}

/** An OmO background task working for a pane (GET /api/pane/omo-tasks), as GOAT shows a native subagent. */
export interface FleetSubagent {
  readonly key: string;
  readonly title: string;
  readonly status: "pending" | "running" | "waiting";
}

export interface FleetThread {
  readonly key: string;
  readonly machineId: string;
  readonly paneId: string;
  /** the pane's P-number */
  readonly number: string;
  readonly title: string;
  readonly workspace: string;
  readonly agentKey: string;
  readonly agentLabel: string;
  readonly agentDriver: string;
  readonly state: FleetThreadState;
  /** OmO background tasks still running for the pane */
  readonly backgroundTasks: number;
}

export interface FleetSnapshot {
  readonly machines: ReadonlyArray<FleetMachine>;
  readonly threads: ReadonlyArray<FleetThread>;
  readonly totals: {
    readonly running: number;
    readonly attention: number;
    readonly reported: number;
    /** answering PCs */
    readonly machines: number;
  };
}

/** Attention first: a pane waiting on the user needs them whatever else it is doing. */
export function classifyFleetPane(pane: Pick<HerdrPane, "agent_status" | "background_tasks">): FleetThreadState | null {
  if (pane.agent_status === "blocked") return "attention";
  if (pane.agent_status === "working" || (pane.background_tasks ?? 0) > 0) return "running";
  if (pane.agent_status === "done") return "reported";
  return null;
}

const OS: Readonly<Record<string, FleetMachineOs>> = { darwin: "darwin", linux: "linux", win32: "windows" };

const agentOf = (pane: HerdrPane): string | null => pane.agent || pane.display_agent || null;

function machineFleet(machine: Machine, host: HostStatus | undefined): { machine: FleetMachine; threads: FleetThread[] } {
  // an offline roster is a cache (see needsInput.ts): a PC that is not connected shows no work
  const answering = machine.state === "connected" && machine.snapshot !== null;
  const snapshot = answering ? machine.snapshot : null;
  const workspaces = new Map((snapshot?.workspaces ?? []).map((workspace) => [workspace.workspace_id, workspace]));
  const agents = new Map<string, { key: string; label: string; driver: string; running: number; attention: number; reported: number }>();
  const threads = (snapshot?.panes ?? [] as HerdrPane[])
    .map((pane, order) => ({ pane: pane as HerdrPane, order, reported: agentOf(pane as HerdrPane), state: classifyFleetPane(pane as HerdrPane), workspace: workspaces.get(pane.workspace_id) }))
    .filter((entry): entry is typeof entry & { reported: string; state: FleetThreadState } => entry.reported !== null && entry.state !== null)
    .sort((a, b) => (a.workspace?.number ?? Number.MAX_SAFE_INTEGER) - (b.workspace?.number ?? Number.MAX_SAFE_INTEGER) || a.order - b.order)
    .map(({ pane, reported, state, workspace }): FleetThread => {
      const { agent, label } = agentIdentity(reported);
      const counted = agents.get(agent) ?? { key: agent, label, driver: agent, running: 0, attention: 0, reported: 0 };
      counted[state] += 1;
      agents.set(agent, counted);
      return {
        key: `${machine.id}:${pane.pane_id}`,
        machineId: machine.id,
        paneId: pane.pane_id,
        number: paneNumber(pane),
        title: pane.label || pane.title || label,
        workspace: workspace?.label ?? "",
        agentKey: agent,
        agentLabel: label,
        agentDriver: agent,
        state,
        backgroundTasks: Math.max(0, pane.background_tasks ?? 0),
      };
    });
  const count = (state: FleetThreadState) => threads.filter((thread) => thread.state === state).length;
  return {
    machine: {
      id: machine.id,
      label: machine.name,
      subtitle: null,
      kind: machine.id === LOCAL_MACHINE ? "environment" : "ssh",
      os: host === undefined ? null : OS[host.platform] ?? null,
      machineKind: host?.machine_kind ?? null,
      answering,
      state: machine.state,
      running: count("running"),
      attention: count("attention"),
      reported: count("reported"),
      agents: [...agents.values()],
    },
    threads,
  };
}

export function buildFleet(machines: ReadonlyArray<Machine>, hosts: ReadonlyMap<string, HostStatus> = new Map()): FleetSnapshot {
  const built = machines.map((machine) => machineFleet(machine, hosts.get(machine.id)));
  const list = built.map((entry) => entry.machine);
  const answering = list.filter((machine) => machine.answering);
  const total = (field: keyof FleetWork) => answering.reduce((sum, machine) => sum + machine[field], 0);
  return {
    machines: list,
    threads: built.flatMap((entry) => entry.threads),
    totals: { running: total("running"), attention: total("attention"), reported: total("reported"), machines: answering.length },
  };
}

const MAC_MODELS: Partial<Record<HostMachineKind, string>> = { laptop: "MacBook", "mac-mini": "Mac mini", "mac-studio": "Mac Studio", desktop: "iMac" };
const OS_NAMES: Record<FleetMachineOs, string> = { darwin: "Mac", linux: "Linux", windows: "Windows" };

function kindName(os: string, kind: HostMachineKind | null): string {
  switch (kind) {
    case "laptop": return t("{os} laptop", { os });
    case "desktop": return t("{os} desktop", { os });
    case "server": return t("{os} server", { os });
    case "cloud": return t("{os} cloud VM", { os });
    case "mac-mini": return t("{os} mini PC", { os });
    case "mac-studio": return t("{os} workstation", { os });
    default: return os;
  }
}

/**
 * GOAT's describeMachine: "MacBook", "Mac Studio", "Linux server", "Windows laptop"; null when
 * nothing is known. A PC's OS and hardware come in one host-status answer, so neither is known alone.
 */
export function fleetMachineSubtitle(machine: Pick<FleetMachine, "os" | "machineKind" | "subtitle">): string | null {
  const { os, machineKind: kind } = machine;
  const described = os === null ? null : os === "darwin" ? (kind && MAC_MODELS[kind]) ?? "Mac" : kindName(OS_NAMES[os], kind);
  const parts = [described, machine.subtitle].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

export const isFleetMachineBusy = (machine: FleetWork) => machine.running + machine.attention + machine.reported > 0;
