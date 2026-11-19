import { describe, expect, test } from "bun:test";
import { AXIS_LOCK_PX, TOUCH_LANDSCAPE_COLS, strokeAxis, touchGrid } from "./touchGrid.ts";

describe("touchGrid", () => {
  test("a desktop grid, or a phone held upright, fits the mount", () => {
    expect(touchGrid({ cols: 51, rows: 30 }, false)).toEqual({ cols: 51, rows: 30, wide: false });
    expect(touchGrid({ cols: 2, rows: 1 }, false)).toEqual({ cols: 2, rows: 1, wide: false });
  });

  test("a phone held sideways is widened past the mount, its rows kept", () => {
    expect(touchGrid({ cols: 100, rows: 13 }, true)).toEqual({ cols: TOUCH_LANDSCAPE_COLS, rows: 13, wide: true });
    expect(touchGrid({ cols: TOUCH_LANDSCAPE_COLS - 1, rows: 12 }, true)).toEqual({ cols: TOUCH_LANDSCAPE_COLS, rows: 12, wide: true });
  });

  test("a sideways screen already that wide fits the mount", () => {
    expect(touchGrid({ cols: TOUCH_LANDSCAPE_COLS, rows: 20 }, true)).toEqual({ cols: TOUCH_LANDSCAPE_COLS, rows: 20, wide: false });
    expect(touchGrid({ cols: 200, rows: 16 }, true)).toEqual({ cols: 200, rows: 16, wide: false });
  });
});

describe("strokeAxis", () => {
  test("a finger that has barely moved keeps no axis", () => {
    expect(strokeAxis(0, 0)).toBeNull();
    expect(strokeAxis(AXIS_LOCK_PX - 1, 0)).toBeNull();
    expect(strokeAxis(-5, 5)).toBeNull();
  });

  test("past the threshold the larger travel wins", () => {
    expect(strokeAxis(AXIS_LOCK_PX, 0)).toBe("x");
    expect(strokeAxis(-12, 4)).toBe("x");
    expect(strokeAxis(3, -AXIS_LOCK_PX)).toBe("y");
    expect(strokeAxis(4, 12)).toBe("y");
  });

  test("an exact diagonal goes up and down", () => {
    expect(strokeAxis(10, -10)).toBe("y");
  });
});
