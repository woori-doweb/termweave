import { describe, expect, test } from "bun:test";
import {
  MAX_PX_PER_MS, REST_MS, SAMPLE_WINDOW_MS, START_PX_PER_MS, STOP_PX_PER_MS, TAU_MS, createVelocityTracker, flingStep, startFling,
} from "./touchFling.ts";

describe("startFling", () => {
  test("a slow lift is not a flick", () => {
    expect(startFling({ vx: 0, vy: START_PX_PER_MS * 0.9 })).toBeNull();
    expect(startFling({ vx: 0.1, vy: -0.1 })).toBeNull();
    expect(startFling({ vx: 0, vy: 0 })).toBeNull();
  });

  test("a flick keeps its velocity", () => {
    expect(startFling({ vx: 0.2, vy: -1.5 })).toEqual({ vx: 0.2, vy: -1.5 });
  });

  test("a wild flick is capped, keeping its direction", () => {
    const v = startFling({ vx: 30, vy: -40 });
    expect(v).not.toBeNull();
    expect(Math.hypot(v!.vx, v!.vy)).toBeCloseTo(MAX_PX_PER_MS, 9);
    expect(v!.vx / v!.vy).toBeCloseTo(30 / -40, 9);
  });
});

describe("flingStep", () => {
  test("the speed decays strictly and the fling stops", () => {
    let v = { vx: 0, vy: 4 };
    let frames = 0;
    let done = false;
    while (!done) {
      const step = flingStep(v, 16);
      expect(Math.abs(step.v.vy)).toBeLessThan(Math.abs(v.vy));
      expect(step.dy).toBeGreaterThan(0);
      v = step.v;
      done = step.done;
      frames++;
      expect(frames).toBeLessThan(1000);
    }
    expect(Math.hypot(v.vx, v.vy)).toBeLessThan(STOP_PX_PER_MS);
  });

  test("a whole fling travels about v*TAU", () => {
    let v = { vx: -1, vy: 3 };
    let x = 0;
    let y = 0;
    for (let done = false; !done; ) {
      const step = flingStep(v, 16);
      x += step.dx;
      y += step.dy;
      v = step.v;
      done = step.done;
    }
    expect(Math.abs(y - 3 * TAU_MS) / (3 * TAU_MS)).toBeLessThan(0.02);
    expect(Math.abs(x + TAU_MS) / TAU_MS).toBeLessThan(0.02);
  });

  test("one 32 ms frame moves as far as two 16 ms frames", () => {
    const v = { vx: 0.5, vy: -2 };
    const whole = flingStep(v, 32);
    const first = flingStep(v, 16);
    const second = flingStep(first.v, 16);
    expect(first.dx + second.dx).toBeCloseTo(whole.dx, 9);
    expect(first.dy + second.dy).toBeCloseTo(whole.dy, 9);
    expect(second.v.vy).toBeCloseTo(whole.v.vy, 12);
  });
});

describe("createVelocityTracker", () => {
  test("a steady drag gives its speed", () => {
    const tracker = createVelocityTracker();
    tracker.reset(1000, 50, 100);
    for (let i = 1; i <= 10; i++) tracker.add(1000 + i * 8, 50 - i * 2, 100 + i * 12);
    const v = tracker.velocity(1080);
    expect(v.vx).toBeCloseTo(-0.25, 9);
    expect(v.vy).toBeCloseTo(1.5, 9);
  });

  test("samples older than the window do not count", () => {
    const tracker = createVelocityTracker();
    // a fast start long before the lift, then a slow steady stretch
    tracker.reset(0, 0, 0);
    tracker.add(10, 0, 500);
    for (let t = 200; t <= 300; t += 10) tracker.add(t, 0, 500 + (t - 200) * 0.5);
    const v = tracker.velocity(300);
    expect(v.vy).toBeCloseTo(0.5, 9);
    // the window is measured from the lift, not from the newest sample
    const late = createVelocityTracker();
    late.reset(0, 0, 0);
    late.add(20, 0, 40);
    late.add(SAMPLE_WINDOW_MS + 30, 0, 50);
    expect(late.velocity(SAMPLE_WINDOW_MS + 30).vy).toBe(0);
  });

  test("a finger that rested before lifting has no speed", () => {
    const tracker = createVelocityTracker();
    tracker.reset(0, 0, 0);
    for (let t = 8; t <= 64; t += 8) tracker.add(t, 0, t * 2);
    expect(tracker.velocity(64 + REST_MS - 1).vy).toBeGreaterThan(0);
    expect(tracker.velocity(64 + REST_MS + 1)).toEqual({ vx: 0, vy: 0 });
  });

  test("a single sample has no speed", () => {
    const tracker = createVelocityTracker();
    tracker.reset(0, 10, 10);
    expect(tracker.velocity(0)).toEqual({ vx: 0, vy: 0 });
  });

  test("reset forgets the previous stroke", () => {
    const tracker = createVelocityTracker();
    tracker.reset(0, 0, 0);
    tracker.add(16, 0, 64);
    tracker.reset(20, 0, 64);
    expect(tracker.velocity(20)).toEqual({ vx: 0, vy: 0 });
  });
});
