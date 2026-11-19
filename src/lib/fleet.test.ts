import { describe, expect, it } from "bun:test";
import type { HostStatus } from "../../shared/hostStatus.ts";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, WorkspaceInfo } from "../../shared/protocol.ts";
import { buildFleet, classifyFleetPane, fleetMachineSubtitle } from "./fleet.ts";

const workspace = (id: string, number: number, label = id): WorkspaceInfo => ({
  active_tab_id: "t", agent_status: "idle", focused: false, label, number, pane_count: 1, tab_count: 1, workspace_id: id,
});

const pane = (id: string, workspaceId: string, agent: string | null, status: string, extra: Partial<HerdrPane> = {}): HerdrPane => ({
  agent, agent_status: status, focused: false, pane_id: id, revision: 1, tab_id: "t", terminal_id: `term-${id}`, workspace_id: workspaceId, ...extra,
});

const machine = (id: string, state: Machine["state"], panes: HerdrPane[], workspaces: WorkspaceInfo[]): Machine => ({
  id, name: id.toUpperCase(), kind: id === "local" ? "local" : "ssh", enabled: true, state, error: null,
  snapshot: { agents: [], layouts: [], panes, protocol: 1, tabs: [], version: "0.9.1", workspaces },
});

const host = (platform: string, machine_kind: HostStatus["machine_kind"]): HostStatus => ({
  sampled_at: 1, platform, machine_kind, cpu_count: 8, cpu_utilization: 0.1, load_avg: null, available_memory_bytes: 1, total_memory_bytes: 2, disk: null, pressure: { level: "ok", reasons: [] }, usage: null,
});

describe("classifyFleetPane", () => {
  it("puts waiting on the user first, then work and held background tasks, then a finished turn", () => {
    expect(classifyFleetPane({ agent_status: "blocked", background_tasks: 2 })).toBe("attention");
    expect(classifyFleetPane({ agent_status: "working" })).toBe("running");
    // an idle run that background tasks hold open still counts as running, as in GOAT
    expect(classifyFleetPane({ agent_status: "idle", background_tasks: 1 })).toBe("running");
    expect(classifyFleetPane({ agent_status: "done" })).toBe("reported");
    expect(classifyFleetPane({ agent_status: "idle" })).toBeNull();
  });
});

describe("buildFleet", () => {
  it("keeps agent panes that are in the Fleet now and folds them into one node per agent kind", () => {
    const fleet = buildFleet([machine("local", "connected", [
      pane("p1", "w1", "claude", "working"),
      pane("p2", "w1", null, "working"),
      pane("p3", "w1", "codex", "blocked"),
      pane("p4", "w1", "claude", "done"),
      pane("p5", "w1", "pi", "idle"),
      pane("p6", "w1", "ClaudeCode", "working"),
    ], [workspace("w1", 1)])]);
    expect(fleet.threads.map((thread) => [thread.paneId, thread.state])).toEqual([["p1", "running"], ["p3", "attention"], ["p4", "reported"], ["p6", "running"]]);
    const [local] = fleet.machines;
    expect(local!.agents).toEqual([
      { key: "claude", label: "Claude Code", driver: "claude", running: 2, attention: 0, reported: 1 },
      { key: "codex", label: "Codex", driver: "codex", running: 0, attention: 1, reported: 0 },
    ]);
    expect({ running: local!.running, attention: local!.attention, reported: local!.reported }).toEqual({ running: 2, attention: 1, reported: 1 });
    expect(fleet.totals).toEqual({ running: 2, attention: 1, reported: 1, machines: 1 });
    expect(local!.kind).toBe("environment");
  });

  it("draws a PC that is not connected without its cached work and leaves it out of the count", () => {
    const fleet = buildFleet([
      machine("box", "reconnecting", [pane("p1", "w1", "claude", "blocked")], [workspace("w1", 1)]),
      machine("local", "connected", [], []),
    ]);
    expect(fleet.machines[0]!.agents).toEqual([]);
    expect(fleet.machines[0]!.answering).toBe(false);
    expect(fleet.machines[0]!.kind).toBe("ssh");
    expect(fleet.totals).toEqual({ running: 0, attention: 0, reported: 0, machines: 1 });
  });

  it("orders work by workspace number and keys it by PC and pane", () => {
    const fleet = buildFleet([
      machine("local", "connected", [pane("a", "w2", "claude", "working"), pane("b", "w1", "codex", "working")], [workspace("w2", 2), workspace("w1", 1)]),
      machine("box", "connected", [pane("a", "w9", "claude", "working")], [workspace("w9", 1)]),
    ]);
    expect(fleet.threads.map((thread) => thread.key)).toEqual(["local:b", "local:a", "box:a"]);
  });

  it("names a pane by its label, then its title, then its agent, and keeps its background task count", () => {
    const fleet = buildFleet([machine("local", "connected", [
      pane("p1", "w1", "claude", "working", { label: "api", title: "ignored" }),
      pane("p2", "w1", "codex", "working", { title: "fix tests" }),
      pane("p3", "w1", null, "working", { display_agent: "gemini" }),
      pane("p4", "w1", "omo", "idle", { background_tasks: 3 }),
    ], [workspace("w1", 1, "voidnews")])]);
    expect(fleet.threads.map((thread) => [thread.title, thread.agentKey, thread.workspace, thread.backgroundTasks])).toEqual([
      ["api", "claude", "voidnews", 0], ["fix tests", "codex", "voidnews", 0], ["Gemini CLI", "gemini", "voidnews", 0], ["OmO", "omo", "voidnews", 3],
    ]);
  });

  it("takes each PC's OS and hardware from its host status", () => {
    const fleet = buildFleet([machine("local", "connected", [], []), machine("box", "connected", [], [])], new Map([["box", host("linux", "server")], ["local", host("darwin", "mac-mini")]]));
    expect(fleet.machines.map((entry) => [entry.os, entry.machineKind])).toEqual([["darwin", "mac-mini"], ["linux", "server"]]);
  });
});

describe("fleetMachineSubtitle", () => {
  it("names a PC by its OS and hardware shape, as GOAT does", () => {
    expect(fleetMachineSubtitle({ os: "darwin", machineKind: "mac-mini", subtitle: null })).toBe("Mac mini");
    expect(fleetMachineSubtitle({ os: "darwin", machineKind: null, subtitle: null })).toBe("Mac");
    expect(fleetMachineSubtitle({ os: "linux", machineKind: "server", subtitle: null })).toBe("Linux server");
    expect(fleetMachineSubtitle({ os: "windows", machineKind: "laptop", subtitle: null })).toBe("Windows laptop");
    expect(fleetMachineSubtitle({ os: "linux", machineKind: "linux", subtitle: null })).toBe("Linux");
    expect(fleetMachineSubtitle({ os: null, machineKind: null, subtitle: null })).toBeNull();
  });
});
