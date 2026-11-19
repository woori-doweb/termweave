// Cases ported from GOAT (https://github.com/goat-si/goat, MIT) at 18b984275d:
// packages/client-runtime/src/state/fleetHeat.test.ts, on TermWeave's host status. See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from "bun:test";
import type { HostStatus } from "../../shared/hostStatus.ts";
import type { ProviderUsage } from "../../shared/protocol.ts";
import { fleetHeatReasons, fleetHeatSignals, fleetHeatTier, fleetMachineHeat, type FleetHeatSignals, type FleetHostEntry } from "./fleetHeat.ts";

const GIB = 1024 ** 3;

function metrics(overrides: Partial<HostStatus> = {}): HostStatus {
  return {
    sampled_at: Date.parse("2026-11-09T00:00:00Z"), platform: "darwin", machine_kind: null, cpu_count: 10, cpu_utilization: 0.1,
    load_avg: { one_minute: 1, five_minutes: 1, fifteen_minutes: 1 }, available_memory_bytes: 48 * GIB, total_memory_bytes: 64 * GIB,
    disk: null, pressure: { level: "ok", reasons: [] }, usage: null, ...overrides,
  };
}

const signals = (overrides: Partial<FleetHeatSignals> = {}): FleetHeatSignals => ({ cpuPercent: 10, loadPerCore: 0.1, memoryPercent: 30, quota: null, ...overrides });

const codex = (weekly: number, extra: Partial<ProviderUsage> = {}): ProviderUsage => ({
  id: "codex", key: "codex:me", account: "me", plan: null, problem: null, checked_at: "2026-11-09T00:00:00Z",
  windows: [{ kind: "session", scope: null, used_percent: 10, resets_at: null }, { kind: "week", scope: null, used_percent: weekly, resets_at: null }],
  ...extra,
});

describe("fleetHeatSignals", () => {
  it("reads CPU, load per core, memory, and the fullest plan-wide usage window", () => {
    expect(fleetHeatSignals(metrics({ cpu_utilization: 0.914, cpu_count: 10, load_avg: { one_minute: 17, five_minutes: 9, fifteen_minutes: 5 }, available_memory_bytes: 16 * GIB, usage: { providers: [codex(82)] } })))
      .toEqual({ cpuPercent: 91, loadPerCore: 1.7, memoryPercent: 75, quota: { label: "Codex weekly", usedPercent: 82 } });
  });

  it("leaves out what the host cannot report", () => {
    expect(fleetHeatSignals(metrics({ cpu_utilization: null, load_avg: null, total_memory_bytes: 0, usage: { providers: [codex(99, { problem: "expired" })] } })))
      .toEqual({ cpuPercent: null, loadPerCore: null, memoryPercent: null, quota: null });
  });

  it("ignores a model's own limit and a window whose reset has passed", () => {
    const sampled = metrics().sampled_at;
    const usage: ProviderUsage = { ...codex(20), windows: [
      { kind: "week", scope: "Sonnet", used_percent: 99, resets_at: null },
      { kind: "session", scope: null, used_percent: 97, resets_at: new Date(sampled - 1000).toISOString() },
      { kind: "week", scope: null, used_percent: 40, resets_at: new Date(sampled + 1000).toISOString() },
    ] };
    expect(fleetHeatSignals(metrics({ usage: { providers: [usage] } })).quota).toEqual({ label: "Codex weekly", usedPercent: 40 });
  });
});

describe("fleetHeatTier", () => {
  it.each([
    [signals(), "normal"],
    [signals({ cpuPercent: 59 }), "normal"],
    [signals({ cpuPercent: 60 }), "warm"],
    [signals({ cpuPercent: 80 }), "hot"],
    [signals({ cpuPercent: 92 }), "burning"],
    [signals({ loadPerCore: 0.7 }), "warm"],
    [signals({ loadPerCore: 1 }), "hot"],
    [signals({ memoryPercent: 90 }), "hot"],
    [signals({ quota: { label: "Codex weekly", usedPercent: 95 } }), "burning"],
    // the hottest signal wins
    [signals({ cpuPercent: 65, loadPerCore: 1.6 }), "burning"],
    [signals({ cpuPercent: null, loadPerCore: null, memoryPercent: null }), "normal"],
  ] as const)("%o is %s", (input, tier) => {
    expect(fleetHeatTier(input)).toBe(tier);
  });

  it("rises on the first sample over a threshold", () => {
    expect(fleetHeatTier(signals({ cpuPercent: 93 }), "normal")).toBe("burning");
  });

  it("holds a tier until the signal falls a margin below its threshold", () => {
    // CPU burning at 92 with an 8 point margin: holds down to 84, then steps to hot
    expect(fleetHeatTier(signals({ cpuPercent: 88 }), "burning")).toBe("burning");
    expect(fleetHeatTier(signals({ cpuPercent: 84 }), "burning")).toBe("burning");
    expect(fleetHeatTier(signals({ cpuPercent: 83 }), "burning")).toBe("hot");
    // load per core: hot at 1.0 with a 0.15 margin
    expect(fleetHeatTier(signals({ loadPerCore: 0.9 }), "hot")).toBe("hot");
    expect(fleetHeatTier(signals({ loadPerCore: 0.8 }), "hot")).toBe("warm");
  });

  it("never holds above the previous tier or below the current reading", () => {
    expect(fleetHeatTier(signals({ cpuPercent: 88 }), "warm")).toBe("hot");
    expect(fleetHeatTier(signals(), "burning")).toBe("normal");
  });

  it("does not flicker across a boundary on noisy samples", () => {
    let tier = fleetHeatTier(signals({ cpuPercent: 81 }));
    const seen = new Set([tier]);
    for (const cpuPercent of [79, 82, 76, 80, 78, 75, 81, 77]) {
      tier = fleetHeatTier(signals({ cpuPercent }), tier);
      seen.add(tier);
    }
    expect([...seen]).toEqual(["hot"]);
  });
});

describe("fleetHeatReasons", () => {
  it("lists only the hot signals, hottest first", () => {
    expect(fleetHeatReasons(signals({ cpuPercent: 91, loadPerCore: 1.74, memoryPercent: 40, quota: { label: "Codex weekly", usedPercent: 82 } })))
      .toEqual(["load 1.7/core", "CPU 91%", "Codex weekly 82%"]);
    expect(fleetHeatReasons(signals())).toEqual([]);
  });
});

describe("fleetMachineHeat", () => {
  const live = (status: HostStatus): FleetHostEntry => ({ reachability: "ok", metrics: status });

  it("says why a PC is hot", () => {
    expect(fleetMachineHeat(live(metrics({ cpu_utilization: 0.91, load_avg: { one_minute: 17, five_minutes: 17, fifteen_minutes: 17 } }))))
      .toMatchObject({ tier: "burning", status: "live", summary: "Burning: load 1.7/core · CPU 91%" });
  });

  it("summarizes a normal PC's load without calling it hot", () => {
    expect(fleetMachineHeat(live(metrics()))).toMatchObject({ tier: "normal", summary: "CPU 10% · load 0.1/core · memory 25%" });
  });

  it("shows no heat for stale, unreachable, unsupported, or unread PCs", () => {
    expect(fleetMachineHeat({ reachability: "unreachable", lastKnown: true, metrics: metrics({ cpu_utilization: 0.99 }) })).toMatchObject({ tier: "normal", status: "stale" });
    expect(fleetMachineHeat({ reachability: "unreachable" }, "burning")).toMatchObject({ tier: "normal", status: "unavailable" });
    expect(fleetMachineHeat({ reachability: "unsupported" })).toMatchObject({ tier: "normal", status: "unavailable" });
    expect(fleetMachineHeat(undefined)).toMatchObject({ tier: "normal", status: "none", summary: "No metrics" });
  });
});
