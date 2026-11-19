import { describe, expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, WorkspaceInfo } from "../../shared/protocol.ts";
import { buildFleetMap } from "./fleetMap.ts";

const workspace = (id: string, number: number): WorkspaceInfo => ({
  active_tab_id: "t", agent_status: "idle", focused: false, label: `WS ${id}`, number, pane_count: 1, tab_count: 1, workspace_id: id,
});
const pane = (id: string, workspaceId: string, agent: string | null, status: string, n: number): HerdrPane => ({
  agent, agent_status: status, focused: false, pane_id: id, revision: 1, tab_id: "t", terminal_id: `term-${id}`, workspace_id: workspaceId, global_pane_number: n,
} as HerdrPane);
const machine = (id: string, state: Machine["state"], panes: HerdrPane[], workspaces: WorkspaceInfo[]): Machine => ({
  id, name: id.toUpperCase(), kind: "local", enabled: true, state, error: null,
  snapshot: { agents: [], layouts: [], panes, protocol: 1, tabs: [], version: "0.9.1", workspaces },
});

describe("buildFleetMap", () => {
  it("lists every agent pane, idle ones too, by project in workspace order, and skips shells and empty projects", () => {
    const map = buildFleetMap([
      machine("local", "connected", [
        pane("a", "w2", "claude", "idle", 7),
        pane("b", "w2", "codex", "working", 3),
        pane("c", "w1", "claude", "blocked", 1),
        pane("d", "w3", null, "unknown", 9),
      ], [workspace("w2", 2), workspace("w1", 1), workspace("w3", 3)]),
      machine("away", "disconnected", [pane("x", "w1", "claude", "working", 4)], [workspace("w1", 1)]),
    ]);
    expect(map.map((m) => m.id)).toEqual(["local"]);
    expect(map[0]!.projects.map((p) => p.label)).toEqual(["WS w1", "WS w2"]);
    expect(map[0]!.projects[1]!.panes.map((p) => [p.number, p.agent, p.state])).toEqual([["P7", "claude", "idle"], ["P3", "codex", "running"]]);
    expect(map[0]!.projects[0]!.panes[0]!.state).toBe("attention");
    // an unnamed pane shows no title rather than repeating "Claude Code"
    expect(map[0]!.projects[0]!.panes[0]!.title).toBeNull();
  });
});
