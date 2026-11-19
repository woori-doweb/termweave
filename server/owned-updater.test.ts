import { describe, expect, it } from "bun:test";
import { PRODUCT_VERSION } from "../shared/product.ts";
import { isNewer, ownedUpdater } from "./owned-updater.ts";

describe("owned updater", () => {
  it("compares release tags as numbers", () => {
    expect(isNewer("v0.3.40", "0.3.39")).toBe(true);
    expect(isNewer("v0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("v0.3.39", "0.3.39")).toBe(false);
    expect(isNewer("v0.3.38", "0.3.39")).toBe(false);
    expect(isNewer("remote-v1.0.0", "0.3.39")).toBe(false);
  });
  it("offers the latest GitHub release when it is newer, and reports a failed check", async () => {
    const [major, minor, patch] = PRODUCT_VERSION.split(".").map(Number);
    const next = `v${major}.${minor}.${patch! + 1}`;
    const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const updater = ownedUpdater("/nowhere", reply({ tag_name: next }));
    updater.request("check"); await Bun.sleep(10);
    expect(updater.status()).toMatchObject({ managed: true, available: true, latest_version: next.slice(1), phase: "idle" });
    const down = ownedUpdater("/nowhere", reply({}, 503));
    down.request("check"); await Bun.sleep(10);
    expect(down.status()).toMatchObject({ available: false, phase: "error" });
    updater.stop(); down.stop();
  });
});
