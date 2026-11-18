/**
 * Momentum for a one-finger scroll: a flick that lifts at speed keeps going and slows down,
 * as every phone's own scrolling does. Pure and deterministic: the caller passes the time in.
 * Velocities are the finger's, in screen px/ms (a finger moving down is a positive vy).
 */

/** Exponential decay time constant: the speed falls to 1/e every TAU_MS, the distance left is v*TAU. */
export const TAU_MS = 325;
/** A lift slower than this is a placement, not a flick: no fling. */
export const START_PX_PER_MS = 0.3;
/** A fling slower than this has visibly stopped. */
export const STOP_PX_PER_MS = 0.03;
/** The fastest fling: a jittery last sample must not throw the view thousands of lines. */
export const MAX_PX_PER_MS = 6;
/** Only the finger's last stretch counts toward its lift speed. */
export const SAMPLE_WINDOW_MS = 100;
/** A finger that rested this long before lifting meant to stop there. */
export const REST_MS = 50;

export interface Velocity {
  vx: number;
  vy: number;
}

export interface FlingFrame {
  dx: number;
  dy: number;
  v: Velocity;
  done: boolean;
}

export interface VelocityTracker {
  /** a new touch: forget the previous stroke, start from this point */
  reset(t: number, x: number, y: number): void;
  add(t: number, x: number, y: number): void;
  /** the finger's speed over the samples within SAMPLE_WINDOW_MS of `now` */
  velocity(now: number): Velocity;
}

interface Sample {
  t: number;
  x: number;
  y: number;
}

const STILL: Velocity = { vx: 0, vy: 0 };

export function createVelocityTracker(): VelocityTracker {
  let samples: Sample[] = [];
  return {
    reset(t, x, y) {
      samples = [{ t, x, y }];
    },
    add(t, x, y) {
      samples.push({ t, x, y });
      // keep the list bounded: nothing older than the window behind the newest sample counts
      const oldest = t - SAMPLE_WINDOW_MS;
      let drop = 0;
      while (drop < samples.length - 1 && samples[drop]!.t < oldest) drop++;
      if (drop > 0) samples = samples.slice(drop);
    },
    velocity(now) {
      const recent = samples.filter((sample) => sample.t >= now - SAMPLE_WINDOW_MS && sample.t <= now);
      if (recent.length < 2) return STILL;
      const first = recent[0]!;
      const last = recent[recent.length - 1]!;
      if (now - last.t > REST_MS) return STILL;
      const dt = last.t - first.t;
      if (dt <= 0) return STILL;
      return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
    },
  };
}

/** The lift velocity a fling starts from, capped to MAX_PX_PER_MS, or null for a slow lift. */
export function startFling(v: Velocity): Velocity | null {
  const speed = Math.hypot(v.vx, v.vy);
  if (!(speed >= START_PX_PER_MS)) return null;
  if (speed <= MAX_PX_PER_MS) return { vx: v.vx, vy: v.vy };
  const scale = MAX_PX_PER_MS / speed;
  return { vx: v.vx * scale, vy: v.vy * scale };
}

/**
 * One frame of the fling: the distance covered in `dtMs` under exponential decay and the speed
 * left. Exact for any dt, so one 32 ms frame moves as far as two 16 ms frames.
 */
export function flingStep(v: Velocity, dtMs: number): FlingFrame {
  const decay = Math.exp(-Math.max(0, dtMs) / TAU_MS);
  const travel = TAU_MS * (1 - decay);
  const next = { vx: v.vx * decay, vy: v.vy * decay };
  return { dx: v.vx * travel, dy: v.vy * travel, v: next, done: Math.hypot(next.vx, next.vy) < STOP_PX_PER_MS };
}
