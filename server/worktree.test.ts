import { expect, it } from "bun:test";
import { parseWorktreeCreate } from "./worktree.ts";

it("trims the branch and the pane of a valid request", () => {
  expect(parseWorktreeCreate({ pane_id: " w1:p1 ", branch: "  feat-a\t" })).toEqual({ ok: true, value: { pane_id: "w1:p1", branch: "feat-a" } });
  expect(parseWorktreeCreate({ pane_id: "w1:p1", branch: "feat-a", base: " main " })).toEqual({ ok: true, value: { pane_id: "w1:p1", branch: "feat-a", base: "main" } });
});

it("rejects an empty, blank or non-string branch", () => {
  for (const branch of [undefined, "", "   ", 7, null]) {
    expect(parseWorktreeCreate({ pane_id: "w1:p1", branch })).toMatchObject({ ok: false, code: "missing_branch" });
  }
});

it("rejects a missing or blank pane_id", () => {
  for (const pane_id of [undefined, "", "  ", 3]) {
    expect(parseWorktreeCreate({ pane_id, branch: "feat-a" })).toMatchObject({ ok: false, code: "missing_pane_id" });
  }
});

it("drops a null or blank base", () => {
  for (const base of [null, "", "   "]) {
    expect(parseWorktreeCreate({ pane_id: "w1:p1", branch: "feat-a", base })).toEqual({ ok: true, value: { pane_id: "w1:p1", branch: "feat-a" } });
  }
});

it("rejects a base that is not a string", () => {
  for (const base of [1, true, {}, ["main"]]) {
    expect(parseWorktreeCreate({ pane_id: "w1:p1", branch: "feat-a", base })).toMatchObject({ ok: false, code: "invalid_base" });
  }
});

it("rejects a body that is not a JSON object", () => {
  for (const body of [null, "feat-a", ["w1:p1", "feat-a"]]) {
    expect(parseWorktreeCreate(body)).toMatchObject({ ok: false, code: "invalid_body" });
  }
});
