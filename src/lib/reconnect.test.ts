import { expect, it } from "bun:test";
import { reconnectDelay, retriesAfterClose, STABLE_AFTER_MS } from "./reconnect.ts";

it("spreads each retry over the upper half of its backoff step", () => {
  expect(reconnectDelay(0, () => 0)).toBe(125);
  expect(reconnectDelay(0, () => 1)).toBe(250);
  expect(reconnectDelay(2, () => 0.5)).toBe(750);
});

it("caps the step at five seconds however many retries failed", () => {
  expect(reconnectDelay(30, () => 0)).toBe(2500);
  expect(reconnectDelay(30, () => 1)).toBe(5000);
});

it("restarts the backoff only after a connection stayed up", () => {
  expect(retriesAfterClose(4, null, 1_000)).toBe(4);
  expect(retriesAfterClose(4, 0, STABLE_AFTER_MS - 1)).toBe(4);
  expect(retriesAfterClose(4, 0, STABLE_AFTER_MS)).toBe(0);
});
