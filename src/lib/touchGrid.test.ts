import { describe, expect, test } from "bun:test";
import { AXIS_LOCK_PX, TOUCH_MIN_COLS, strokeAxis, touchGrid } from "./touchGrid.ts";

describe("touchGrid", () => {
  test("a desktop grid is never widened", () => {
    expect(touchGrid({ cols: 51, rows: 30 }, false)).toEqual({ cols: 51, rows: 30, wide: false });
    expect(touchGrid({ cols: 2, rows: 1 }, false)).toEqual({ cols: 2, rows: 1, wide: false });
  });

  test("a touch grid below the minimum is widened, its rows kept", () => {
    expect(touchGrid({ cols: 51, rows: 37 }, true)).toEqual({ cols: TOUCH_MIN_COLS, rows: 37, wide: true });
    expect(touchGrid({ cols: TOUCH_MIN_COLS - 1, rows: 12 }, true)).toEqual({ cols: TOUCH_MIN_COLS, rows: 12, wide: true });
  });

  test("a touch grid at or above the minimum fits the mount", () => {
    expect(touchGrid({ cols: TOUCH_MIN_COLS, rows: 20 }, true)).toEqual({ cols: TOUCH_MIN_COLS, rows: 20, wide: false });
    expect(touchGrid({ cols: 114, rows: 16 }, true)).toEqual({ cols: 114, rows: 16, wide: false });
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
