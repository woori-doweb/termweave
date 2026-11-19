/**
 * The terminal socket's reconnect policy, after GOAT's connection supervisor
 * (docs/internals/connection-runtime.md, MIT): jittered exponential backoff that
 * resets only once a connection stayed up.
 */
export const RECONNECT_BASE_MS = 250;
export const RECONNECT_CAP_MS = 5000;
/** A connection that lasted this long was healthy; a shorter one is a flap and keeps backing off. */
export const STABLE_AFTER_MS = 30_000;

/**
 * Each step waits a random time in the upper half of its exponential step. Every pane has its
 * own socket, so without jitter a restarted server takes all of a client's reconnects in the
 * same instant.
 */
export function reconnectDelay(retries: number, random: () => number = Math.random): number {
  const step = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** retries);
  return Math.round(step / 2 + (random() * step) / 2);
}

/** The retry count after a close: back to zero only when the connection had stayed up. */
export function retriesAfterClose(retries: number, openedAt: number | null, now: number): number {
  return openedAt !== null && now - openedAt >= STABLE_AFTER_MS ? 0 : retries;
}
