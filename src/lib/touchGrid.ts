/**
 * A phone's own grid. Held upright it fits the screen, as it always did: every edge of the
 * terminal stays in sight. Turned sideways it is wider than the screen instead, and the finger
 * pans across the part past the mount's edge: long lines and tables (PowerShell's `ls` with
 * long names) keep one line each. Pure: the caller passes the fit addon's proposal and whether
 * this is a touch screen held sideways.
 */

/** The width a touch screen held sideways gets: well past its own (about 100 columns), so a line that long reads in one row. */
export const TOUCH_LANDSCAPE_COLS = 160;

/** How far a finger travels before its stroke is taken as across or up and down. */
export const AXIS_LOCK_PX = 8;

/** The grid for a proposed fit: wide when it is wider than the mount, which then pans. */
export function touchGrid(proposed: { cols: number; rows: number }, touchLandscape: boolean): { cols: number; rows: number; wide: boolean } {
  return touchLandscape && proposed.cols < TOUCH_LANDSCAPE_COLS
    ? { cols: TOUCH_LANDSCAPE_COLS, rows: proposed.rows, wide: true }
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
