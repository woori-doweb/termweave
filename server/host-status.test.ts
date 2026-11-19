import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostStatus } from "../shared/hostStatus.ts";
import { classifyPressure, darwinAvailableMemory, diskFromStatfs, diskPathForPlatform, handleHostStatusRequest, holdPressure, HostStatusService, loadAverageForPlatform, machineKindFromAppleProductName, machineKindFromDmi } from "./host-status.ts";

const GIB = 1024 ** 3;
const calm = { cpu_utilization: 0.1, load_avg: { one_minute: 1, five_minutes: 1, fifteen_minutes: 1 }, cpu_count: 8, available_memory_bytes: 8 * GIB, total_memory_bytes: 16 * GIB, disk: { available_bytes: 400 * GIB, total_bytes: 1000 * GIB } };

describe("host readings", () => {
  it("reads macOS available memory as free, inactive and speculative pages", () => {
    const output = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               1000.\nPages active:                             9999.\nPages inactive:                           2000.\nPages speculative:                         500.\n";
    expect(darwinAvailableMemory(output)).toBe(3500 * 16384);
    expect(darwinAvailableMemory("Pages free: 12.")).toBeNull();
  });

  it("keeps no load average on Windows, where os.loadavg() is zeros", () => {
    expect(loadAverageForPlatform("win32", [0, 0, 0])).toBeNull();
    expect(loadAverageForPlatform("linux", [1.5, 1, 0.5])).toEqual({ one_minute: 1.5, five_minutes: 1, fifteen_minutes: 0.5 });
    expect(loadAverageForPlatform("darwin", [Number.NaN, 1, 1])).toBeNull();
  });

  it("reads the volume of the state folder, the drive root on Windows", () => {
    expect(diskPathForPlatform("darwin", "/srv/termweave/state")).toBe("/srv/termweave/state");
    expect(diskPathForPlatform("linux", "relative")).toBe("/");
    expect(diskPathForPlatform("win32", "D:/termweave/state")).toBe("D:\\");
    expect(diskPathForPlatform("win32", "\\\\share\\x")).toBeNull();
    expect(diskFromStatfs("linux", { bsize: 4096, blocks: 100, bavail: 25 })).toEqual({ available_bytes: 25 * 4096, total_bytes: 100 * 4096 });
    expect(diskFromStatfs("win32", { bsize: 4096, blocks: 0, bavail: 0 })).toBeNull();
    expect(diskFromStatfs("linux", { bsize: 4096, blocks: 1, bavail: 2 })).toBeNull();
  });

  it("names the hardware from Apple's product name and Linux DMI", () => {
    expect(machineKindFromAppleProductName("Mac mini")).toBe("mac-mini");
    expect(machineKindFromAppleProductName("MacBookPro18,3")).toBe("laptop");
    expect(machineKindFromAppleProductName("Mac Studio")).toBe("mac-studio");
    expect(machineKindFromAppleProductName("iMac21,1")).toBe("desktop");
    expect(machineKindFromDmi({ chassisType: "10", sysVendor: "LENOVO", productName: "ThinkPad" })).toBe("laptop");
    expect(machineKindFromDmi({ chassisType: "1", sysVendor: "QEMU", productName: "Standard PC" })).toBe("cloud");
    expect(machineKindFromDmi({ chassisType: "17", sysVendor: "Dell", productName: "PowerEdge" })).toBe("server");
    expect(machineKindFromDmi({ chassisType: null, sysVendor: null, productName: null })).toBeNull();
  });
});

describe("host pressure", () => {
  it("is ok on a calm host and names each signal over its threshold, worst first", () => {
    expect(classifyPressure(calm)).toEqual({ level: "ok", reasons: [] });
    const loaded = classifyPressure({ ...calm, cpu_utilization: 0.95, load_avg: { ...calm.load_avg, one_minute: 32 } });
    expect(loaded.level).toBe("critical");
    expect(loaded.reasons.map((reason) => [reason.signal, reason.level])).toEqual([["load", "critical"], ["cpu", "elevated"]]);
    expect(loaded.reasons[0]!.message).toBe("load 4 per core (threshold 3)");
    expect([loaded.reasons[0]!.value, loaded.reasons[0]!.threshold]).toEqual([4, 3]);
  });

  it("judges a disk by both its free GiB and its free share", () => {
    // 40 GiB free of 100 is under 50 GiB but over 15%: the smaller limit decides
    expect(classifyPressure({ ...calm, disk: { available_bytes: 40 * GIB, total_bytes: 100 * GIB } }).level).toBe("ok");
    expect(classifyPressure({ ...calm, disk: { available_bytes: 10 * GIB, total_bytes: 100 * GIB } }).reasons[0]).toEqual({ signal: "disk", level: "elevated", message: "disk 10 GiB free (10%), under 50 GiB and 15%", value: 10, threshold: 50, free_percent: 10, threshold_percent: 15 });
    expect(classifyPressure({ ...calm, disk: { available_bytes: 4 * GIB, total_bytes: 1000 * GIB } }).level).toBe("critical");
  });

  it("rises at once and falls only once readings clear the threshold by a margin", () => {
    const heavy = { ...calm, load_avg: { ...calm.load_avg, one_minute: 13 } }; // 1.625 per core
    expect(holdPressure(heavy, "ok").level).toBe("elevated");
    const easing = { ...calm, load_avg: { ...calm.load_avg, one_minute: 11 } }; // 1.375: under 1.5, over 1.2
    expect(holdPressure(easing, "elevated").level).toBe("elevated");
    expect(holdPressure(easing, "ok").level).toBe("ok");
    expect(holdPressure({ ...calm, load_avg: { ...calm.load_avg, one_minute: 9 } }, "elevated").level).toBe("ok");
    // a critical host easing below critical but within the margin keeps no more than critical
    expect(holdPressure({ ...calm, load_avg: { ...calm.load_avg, one_minute: 22 } }, "critical").level).toBe("critical");
  });
});

describe("host status service", () => {
  it("samples this host once per 5 s and carries the last usage report without asking for one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-status-"));
    let asked = 0;
    try {
      const service = new HostStatusService(dir, () => { asked += 1; return { providers: [] }; });
      const first = service.read();
      expect(service.read()).toBe(first);
      const status = await first;
      expect(status.cpu_count).toBeGreaterThan(0);
      expect(status.total_memory_bytes).toBeGreaterThan(0);
      expect(status.available_memory_bytes).toBeLessThanOrEqual(status.total_memory_bytes);
      expect(status.platform).toBe(process.platform);
      expect(status.usage).toEqual({ providers: [] });
      expect(asked).toBe(1);
      const response = await handleHostStatusRequest(new Request("http://x/api/host-status"), service);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(((await response.json()) as HostStatus).sampled_at).toBe(status.sampled_at);
      expect((await handleHostStatusRequest(new Request("http://x/api/host-status", { method: "POST" }), service)).status).toBe(405);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
