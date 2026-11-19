/**
 * GET /api/host-status: the host this server runs on, read the way GOAT's server reads it
 * (apps/server/src/resourceTelemetry/HostResources.ts, hostCapacity.ts,
 * environment/ServerEnvironmentMachine.ts and fleet/pressure/pressureModel.ts; MIT, see
 * THIRD_PARTY_NOTICES.md). Nothing is polled: a read samples, and answers within 5 s share it.
 */
import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import * as os from "node:os";
import type { HostMachineKind, HostPressure, HostPressureLevel, HostPressureReason, HostStatus } from "../shared/hostStatus.ts";
import type { UsageReport } from "../shared/protocol.ts";
import { jsonResponse } from "./http.ts";

const CPU_WINDOW_MS = 200;
const CACHE_MS = 5_000;

function readCpu() {
  const cpus = os.cpus();
  const cpu = cpus.reduce((sum, { times }) => ({ idle: sum.idle + times.idle, total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq }), { idle: 0, total: 0 });
  return { ...cpu, count: cpus.length };
}

export function darwinAvailableMemory(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1];
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1];
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1];
  if (!pageSize || !free || !inactive || !speculative) return null;
  // vm_stat excludes speculative from free; add it once, without overlapping purgeable pages.
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize);
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null;
}

/** Windows `os.loadavg()` is `[0, 0, 0]`, which is not a load average. */
export function loadAverageForPlatform(platform: NodeJS.Platform, loadavg: readonly number[]): HostStatus["load_avg"] {
  if (platform !== "linux" && platform !== "darwin") return null;
  const [one, five, fifteen] = loadavg;
  if (![one, five, fifteen].every((value) => value !== undefined && Number.isFinite(value))) return null;
  return { one_minute: one!, five_minutes: five!, fifteen_minutes: fifteen! };
}

/** The volume holding a folder: Windows asks its drive root, and a path without a drive is not asked. */
export function diskPathForPlatform(platform: NodeJS.Platform, dataDir: string): string | null {
  if (platform === "linux" || platform === "darwin") return dataDir.startsWith("/") ? dataDir : "/";
  if (platform !== "win32") return null;
  const drive = /^([A-Za-z]:)/.exec(dataDir.replaceAll("/", "\\"));
  return drive === null ? null : `${drive[1]}\\`;
}

/** A Windows volume that cannot be queried reports zero blocks: missing data, not an empty disk. */
export function diskFromStatfs(platform: NodeJS.Platform, stats: { bsize: number; blocks: number; bavail: number }): HostStatus["disk"] {
  if (!(stats.bsize > 0) || stats.blocks < 0 || stats.bavail < 0) return null;
  if (platform === "win32" && stats.blocks === 0) return null;
  const total = stats.blocks * stats.bsize;
  const available = stats.bavail * stats.bsize;
  if (available > total || !Number.isSafeInteger(total) || !Number.isSafeInteger(available)) return null;
  return { available_bytes: available, total_bytes: total };
}

const run = (command: string, args: string[]) => new Promise<string | null>((resolve) => {
  execFile(command, args, { timeout: 5_000, windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout).trim() || null));
});
const readOptional = (path: string) => readFile(path, "utf8").then((text) => text.trim() || null, () => null);

export function machineKindFromAppleProductName(name: string): HostMachineKind | null {
  const normalized = name.trim().toLowerCase().replaceAll(/\s+/g, "");
  if (normalized.startsWith("macmini")) return "mac-mini";
  if (normalized.startsWith("macstudio")) return "mac-studio";
  if (normalized.startsWith("macbook")) return "laptop";
  if (normalized.startsWith("imac") || normalized.startsWith("macpro")) return "desktop";
  return null;
}

// SMBIOS 3.x System Enclosure types (table 17).
const DMI_CHASSIS_KINDS: Readonly<Record<string, HostMachineKind>> = {
  "3": "desktop", "4": "desktop", "5": "desktop", "6": "desktop", "7": "desktop", "8": "laptop", "9": "laptop", "10": "laptop",
  "13": "desktop", "14": "laptop", "15": "desktop", "16": "desktop", "17": "server", "18": "server", "19": "server", "20": "server",
  "21": "server", "22": "server", "23": "server", "24": "server", "28": "server", "31": "laptop", "32": "laptop", "35": "desktop",
};
// VMs read as cloud whatever their chassis. Hyper-V is matched by product, since Surface shares its vendor.
const VIRTUALIZATION_MARKERS = ["qemu", "kvm", "bochs", "vmware", "virtualbox", "innotek", "xen", "parallels", "amazon ec2", "google compute engine", "digitalocean", "hetzner", "linode", "vultr", "scaleway", "openstack", "cloud", "virtual machine"];

export function machineKindFromDmi(input: { chassisType: string | null; sysVendor: string | null; productName: string | null }): HostMachineKind | null {
  const productName = input.productName ?? "";
  if (VIRTUALIZATION_MARKERS.some((marker) => `${input.sysVendor ?? ""} ${productName}`.toLowerCase().includes(marker))) return "cloud";
  return machineKindFromAppleProductName(productName) ?? (input.chassisType === null ? null : DMI_CHASSIS_KINDS[input.chassisType] ?? null);
}

async function detectMachineKind(platform: NodeJS.Platform): Promise<HostMachineKind | null> {
  if (platform === "darwin") {
    // Apple silicon gives IOKit's marketing name; Intel needs hw.model.
    const productName = (await run("ioreg", ["-rd1", "-n", "product"]))?.match(/"product-name"\s*=\s*<"([^"]+)">/)?.[1] ?? null;
    const kind = productName === null ? null : machineKindFromAppleProductName(productName);
    if (kind !== null) return kind;
    const model = await run("sysctl", ["-n", "hw.model"]);
    return model === null ? null : machineKindFromAppleProductName(model);
  }
  if (platform !== "linux") return null;
  const dmi = "/sys/class/dmi/id";
  const [kernel, chassisType, sysVendor, productName] = await Promise.all([readOptional("/proc/sys/kernel/osrelease"), readOptional(`${dmi}/chassis_type`), readOptional(`${dmi}/sys_vendor`), readOptional(`${dmi}/product_name`)]);
  // WSL first: WSL 2 shows as a Hyper-V VM in DMI.
  if (kernel?.toLowerCase().includes("microsoft")) return "linux";
  return machineKindFromDmi({ chassisType, sysVendor, productName });
}

/** GOAT's DEFAULT_HOST_PRESSURE_SETTINGS. */
export const PRESSURE = {
  elevatedLoadPerCore: 1.5, criticalLoadPerCore: 3, elevatedCpuPercent: 90,
  elevatedMemoryFreePercent: 10, criticalMemoryFreePercent: 5,
  elevatedDiskFreeGiB: 50, criticalDiskFreeGiB: 15, elevatedDiskFreePercent: 15, criticalDiskFreePercent: 5,
} as const;
/** A level is left only once its readings fall this far below the thresholds that raised it. */
const EXIT_RATIO = 0.8;
const GIB = 1024 ** 3;
const RANK: Record<HostPressureLevel, number> = { ok: 0, elevated: 1, critical: 2 };
const round1 = (value: number) => Math.round(value * 10) / 10;

/** Free bytes at or below which a disk is at a level: under both the GiB limit and the share of the volume. */
const diskThresholdBytes = (total: number | null, gib: number, percent: number) => total === null || total <= 0 ? gib * GIB : Math.min(gib * GIB, (total * percent) / 100);

type Readings = Pick<HostStatus, "cpu_utilization" | "load_avg" | "cpu_count" | "available_memory_bytes" | "total_memory_bytes" | "disk">;

/**
 * GOAT's classify(): the level one sample shows. `scale` below 1 loosens every threshold, so a
 * host stays at a level until its readings fall clear of where they rose.
 * ponytail: no sustain window (GOAT waits 3 min before raising); samples come only while Fleet is open.
 */
export function classifyPressure(sample: Readings, scale = 1): HostPressure {
  const reasons: HostPressureReason[] = [];
  const above = (signal: HostPressureReason["signal"], value: number | null, elevated: number | null, critical: number | null, describe: (value: number, threshold: number) => string) => {
    if (value === null) return;
    if (critical !== null && value >= critical * scale) reasons.push({ signal, level: "critical", message: describe(value, critical), value: round1(value), threshold: critical });
    else if (elevated !== null && value >= elevated * scale) reasons.push({ signal, level: "elevated", message: describe(value, elevated), value: round1(value), threshold: elevated });
  };
  const below = (signal: HostPressureReason["signal"], value: number | null, elevated: number, critical: number, describe: (value: number, threshold: number) => string) => {
    if (value === null) return;
    if (value <= critical / scale) reasons.push({ signal, level: "critical", message: describe(value, critical), value: Math.round(value), threshold: critical });
    else if (value <= elevated / scale) reasons.push({ signal, level: "elevated", message: describe(value, elevated), value: Math.round(value), threshold: elevated });
  };
  const perCore = sample.load_avg === null || !(sample.cpu_count > 0) ? null : sample.load_avg.one_minute / sample.cpu_count;
  above("load", perCore, PRESSURE.elevatedLoadPerCore, PRESSURE.criticalLoadPerCore, (value, threshold) => `load ${round1(value)} per core (threshold ${threshold})`);
  above("cpu", sample.cpu_utilization === null ? null : sample.cpu_utilization * 100, PRESSURE.elevatedCpuPercent, null, (value, threshold) => `CPU ${Math.round(value)}% (threshold ${threshold}%)`);
  below("memory", sample.total_memory_bytes > 0 ? (sample.available_memory_bytes / sample.total_memory_bytes) * 100 : null, PRESSURE.elevatedMemoryFreePercent, PRESSURE.criticalMemoryFreePercent, (value, threshold) => `memory ${Math.round(value)}% free (threshold ${threshold}%)`);
  if (sample.disk !== null) {
    const free = sample.disk.available_bytes;
    const total = sample.disk.total_bytes > 0 ? sample.disk.total_bytes : null;
    const reached = (gib: number, percent: number) => free <= diskThresholdBytes(total, gib, percent) / scale;
    const describe = (gib: number, percent: number) => `disk ${round1(free / GIB)} GiB free${total === null ? "" : ` (${Math.round((free / total) * 100)}%)`}, under ${gib} GiB${total === null ? "" : ` and ${percent}%`}`;
    const readings = (gib: number, percent: number) => ({ value: round1(free / GIB), threshold: gib, ...(total === null ? {} : { free_percent: Math.round((free / total) * 100), threshold_percent: percent }) });
    if (reached(PRESSURE.criticalDiskFreeGiB, PRESSURE.criticalDiskFreePercent)) reasons.push({ signal: "disk", level: "critical", message: describe(PRESSURE.criticalDiskFreeGiB, PRESSURE.criticalDiskFreePercent), ...readings(PRESSURE.criticalDiskFreeGiB, PRESSURE.criticalDiskFreePercent) });
    else if (reached(PRESSURE.elevatedDiskFreeGiB, PRESSURE.elevatedDiskFreePercent)) reasons.push({ signal: "disk", level: "elevated", message: describe(PRESSURE.elevatedDiskFreeGiB, PRESSURE.elevatedDiskFreePercent), ...readings(PRESSURE.elevatedDiskFreeGiB, PRESSURE.elevatedDiskFreePercent) });
  }
  reasons.sort((a, b) => RANK[b.level] - RANK[a.level]);
  return { level: reasons[0]?.level ?? "ok", reasons };
}

/** A new sample's level given the last one: rising is immediate, falling waits for EXIT_RATIO. */
export function holdPressure(sample: Readings, previous: HostPressureLevel): HostPressure {
  const now = classifyPressure(sample);
  if (RANK[now.level] >= RANK[previous]) return now;
  const held = classifyPressure(sample, EXIT_RATIO);
  return RANK[held.level] > RANK[now.level] ? { level: RANK[held.level] >= RANK[previous] ? previous : held.level, reasons: held.reasons } : now;
}

export class HostStatusService {
  private cached: { at: number; status: Promise<HostStatus> } | null = null;
  private kind: Promise<HostMachineKind | null> | null = null;
  private pressure: HostPressureLevel = "ok";

  constructor(private readonly dataDir: string, private readonly usage: () => UsageReport | null, private readonly platform: NodeJS.Platform = process.platform) {}

  read(): Promise<HostStatus> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.status;
    const status = this.sample();
    this.cached = { at: now, status };
    status.catch(() => { if (this.cached?.status === status) this.cached = null; });
    return status;
  }

  private async sample(): Promise<HostStatus> {
    const { platform } = this;
    this.kind ??= detectMachineKind(platform).catch(() => null);
    const before = readCpu();
    // CPU counters need two readings; disk and memory are read during the window.
    const diskPath = diskPathForPlatform(platform, this.dataDir);
    const [, disk, availableMemory, machineKind] = await Promise.all([
      new Promise((resolve) => setTimeout(resolve, CPU_WINDOW_MS)),
      diskPath === null ? null : statfs(diskPath).then((stats) => diskFromStatfs(platform, stats), () => null),
      this.availableMemory(),
      this.kind,
    ]);
    const after = readCpu();
    const totalDelta = after.total - before.total;
    const idleDelta = after.idle - before.idle;
    const total = os.totalmem();
    const readings: Readings = {
      cpu_utilization: before.count === after.count && totalDelta > 0 && idleDelta >= 0 ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta)) : null,
      cpu_count: after.count,
      load_avg: loadAverageForPlatform(platform, os.loadavg()),
      available_memory_bytes: Math.min(total, Math.max(0, availableMemory)),
      total_memory_bytes: total,
      disk,
    };
    const pressure = holdPressure(readings, this.pressure);
    this.pressure = pressure.level;
    return { sampled_at: Date.now(), platform, machine_kind: machineKind, ...readings, pressure, usage: this.usage() };
  }

  /** On Windows libuv already returns available memory, standby included. */
  private async availableMemory(): Promise<number> {
    const free = os.freemem();
    if (this.platform === "linux") {
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(await readFile("/proc/meminfo", "utf8").catch(() => ""))?.[1];
      return available ? Number(available) * 1024 : free;
    }
    if (this.platform === "darwin") return darwinAvailableMemory(await run("/usr/bin/vm_stat", []) ?? "") ?? free;
    return free;
  }
}

export async function handleHostStatusRequest(request: Request, service: HostStatusService): Promise<Response> {
  if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET /api/host-status" } }, 405, { allow: "GET" });
  return jsonResponse(await service.read(), 200, { "cache-control": "no-store" });
}
