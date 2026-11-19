/**
 * A phone's own grid: the mount of a phone held upright fits about fifty columns, and a
 * program that lays out a table for that width squeezes it unreadable. On a touch screen
 * the grid keeps a minimum width instead, and the finger pans across the part past the
 * mount's edge. Pure: the caller passes the fit addon's proposal and whether it is a touch screen.
 */

/**
 * The narrowest grid a touch screen gets: a table such as PowerShell's `ls` keeps its
 * columns (at 51 the Name column wrapped to one letter per row), and the phone pans across it.
 */
export const TOUCH_MIN_COLS = 100;

/** How far a finger travels before its stroke is taken as across or up and down. */
export const AXIS_LOCK_PX = 8;

/** The grid for a proposed fit: wide when it is wider than the mount, which then pans. */
export function touchGrid(proposed: { cols: number; rows: number }, touch: boolean): { cols: number; rows: number; wide: boolean } {
  return touch && proposed.cols < TOUCH_MIN_COLS
    ? { cols: TOUCH_MIN_COLS, rows: proposed.rows, wide: true }
    : { ...proposed, wide: false };
}

/**
 * The axis a stroke on a wide grid keeps, from the finger's travel since it landed: none
 * until it has moved AXIS_LOCK_PX, then across when it went more sideways than up or down.
 */
export function strokeAxis(dx: number, dy: number): "x" | "y" | null {
  if (Math.hypot(dx, dy) < AXIS_LOCK_PX) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}
