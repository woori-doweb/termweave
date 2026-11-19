import type { UsageReport } from "./protocol.ts";

/**
 * GET /api/host-status: how hard the PC a server runs on is working, for the Fleet graph's heat
 * and its telemetry console. Ported from GOAT's HostStatusMetrics (MIT, see
 * THIRD_PARTY_NOTICES.md) and cut to what a TermWeave server can read about its own host.
 * A PC's own server answers it; the web server relays it for another PC through
 * /api/machines/<id>/host-status, and a bridge older than this answers 404.
 */
export interface HostStatus {
  /** epoch ms */
  readonly sampled_at: number;
  /** `process.platform`: linux, darwin, win32 */
  readonly platform: string;
  /** the hardware's shape, when the OS says it; null otherwise */
  readonly machine_kind: HostMachineKind | null;
  readonly cpu_count: number;
  /** share of every CPU in use over a 200 ms window, 0 to 1; null when the counters did not move */
  readonly cpu_utilization: number | null;
  /** null where the OS keeps no load average (Windows) */
  readonly load_avg: { readonly one_minute: number; readonly five_minutes: number; readonly fifteen_minutes: number } | null;
  /** available memory, not just free pages (MemAvailable, or free + inactive + speculative on macOS) */
  readonly available_memory_bytes: number;
  readonly total_memory_bytes: number;
  /** the volume the server's state directory sits on; null when it cannot be read */
  readonly disk: { readonly available_bytes: number; readonly total_bytes: number } | null;
  /** the host's own verdict on these readings, held with hysteresis between samples */
  readonly pressure: HostPressure;
  /**
   * The plan usage this server last read for its own sign-ins, or null when nothing has asked it
   * (GET /api/usage). Reading host status never asks a provider: only the usage meters do, once chosen.
   */
  readonly usage: UsageReport | null;
}

export type HostMachineKind = "laptop" | "desktop" | "server" | "cloud" | "linux" | "mac-mini" | "mac-studio";

export type HostPressureLevel = "ok" | "elevated" | "critical";

export interface HostPressureReason {
  readonly signal: "load" | "cpu" | "memory" | "disk";
  readonly level: Exclude<HostPressureLevel, "ok">;
  /** in English, for logs and older clients; a client words it from the readings below */
  readonly message: string;
  /** load per core, CPU percent in use, memory percent free; for a disk, GiB free */
  readonly value: number;
  /** the threshold crossed, in the same unit; for a disk, its GiB limit */
  readonly threshold: number;
  /** a disk's free share and share limit, percent, when its size is known */
  readonly free_percent?: number;
  readonly threshold_percent?: number;
}

export interface HostPressure {
  readonly level: HostPressureLevel;
  /** the worst first */
  readonly reasons: readonly HostPressureReason[];
}
