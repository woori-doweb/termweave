/**
 * /api/worktree/*: a terminal's "new terminal in a worktree" and its removal. herdr makes the
 * git worktree from the pane's folder; a branch and pane are required, a base is optional (null
 * or blank: herdr branches from the current HEAD).
 */
import { HerdrError } from "./herdr/client.ts";
import { errorResponse, isJsonObject, jsonResponse } from "./http.ts";

export interface WorktreeCreateInput {
  pane_id: string;
  branch: string;
  base?: string;
}

export type WorktreeCreateParse = { ok: true; value: WorktreeCreateInput } | { ok: false; code: string; message: string };

export function parseWorktreeCreate(payload: unknown): WorktreeCreateParse {
  if (!isJsonObject(payload)) return { ok: false, code: "invalid_body", message: "request body must be a JSON object" };
  const paneId = typeof payload.pane_id === "string" ? payload.pane_id.trim() : "";
  if (paneId === "") return { ok: false, code: "missing_pane_id", message: "pane_id is required" };
  const branch = typeof payload.branch === "string" ? payload.branch.trim() : "";
  if (branch === "") return { ok: false, code: "missing_branch", message: "branch is required" };
  if (payload.base !== undefined && payload.base !== null && typeof payload.base !== "string") {
    return { ok: false, code: "invalid_base", message: "base must be a string" };
  }
  const base = typeof payload.base === "string" ? payload.base.trim() : "";
  return { ok: true, value: { pane_id: paneId, branch, ...(base === "" ? {} : { base }) } };
}

/**
 * herdr refusing a worktree (the branch or folder exists, a dirty checkout without force) is a
 * 409 carrying herdr's code unchanged: the client asks again with force on `dirty_worktree_requires_force`.
 */
export function worktreeFailure(error: unknown): Response {
  if (error instanceof HerdrError) return jsonResponse({ error: { code: error.code, message: error.message } }, 409);
  return errorResponse(error);
}
