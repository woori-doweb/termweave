/**
 * The text that inserts file paths into a pane's prompt, quoted for the shell the pane runs.
 *
 * Quoting follows the pane's real shell because no single quoting is safe in all of them:
 * PowerShell runs `$(…)` inside `"…"`, cmd.exe takes `'…'` as no quote at all (so `&` in
 * `'C:\a&whoami&b.txt'` runs a command), and a POSIX shell eats a bare backslash. A path that
 * shell cannot safely receive is refused, and so is any path that is not plain when the shell
 * is unknown.
 *
 * A path holding a control character is refused, not stripped: a terminal reads ESC or CR inside
 * pasted text as keys (ESC[201~ ends a bracketed paste, CR runs the line), and a name with the
 * characters stripped would point at another file.
 */
import { HerdrError, sessionSnapshot } from "./herdr/client.ts";
import { psQuote } from "./powershell.ts";
import { MAX_INSERT_FILES } from "../shared/insert-files.ts";
import { cmdQuote, paneShell, type PaneShell, processInfo, quote } from "./shell-agent.ts";

const MAX_PATH_LENGTH = 4096;

/** C0 controls, DEL and C1 controls: a terminal may act on any of them as a key or a sequence. */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
/** What each shell takes literally without quotes. */
const POSIX_BARE = /^[\p{L}\p{N}_./:-]+$/u;
const WINDOWS_BARE = /^[\p{L}\p{N}_./:\\-]+$/u;

/** A path the pane's shell cannot safely receive; the route answers it as 400 `unsafe_path`. */
export class UnsafePathError extends Error {
  readonly code = "unsafe_path";
}

/** The request's paths, or null unless they are 1 to 20 non-empty strings of at most 4096 characters. */
export function validPaths(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INSERT_FILES) return null;
  return value.every((path) => typeof path === "string" && path.length > 0 && path.length <= MAX_PATH_LENGTH) ? value as string[] : null;
}

function quoted(shell: PaneShell | "unknown", path: string): string {
  if (CONTROL.test(path)) throw new UnsafePathError("a file path holds a control character");
  if (shell === "posix") return POSIX_BARE.test(path) ? path : quote(path);
  if (shell === "powershell") return WINDOWS_BARE.test(path) ? path : psQuote(path);
  if (shell === "cmd") {
    if (WINDOWS_BARE.test(path)) return path;
    try { return cmdQuote(path); } catch { throw new UnsafePathError("cmd.exe cannot take a file path holding \", % or !"); }
  }
  // a shell neither side knows takes only what every shell reads alike: not a backslash, which a
  // POSIX shell on Windows (Git Bash) would eat as well as a Linux one
  if (POSIX_BARE.test(path)) return path;
  throw new UnsafePathError("this pane's shell is unknown, so only a plain file path can be typed into it");
}

/** Each path quoted for `shell`, joined by a space, with one trailing space; throws UnsafePathError. */
export function shellText(shell: PaneShell | "unknown", paths: readonly string[]): string {
  return `${paths.map((path) => quoted(shell, path)).join(" ")} `;
}

/** The shell in front of the pane, as shell-agent reads it; `unknown` when herdr does not say. */
export async function paneShellOf(paneId: string): Promise<PaneShell | "unknown"> {
  if (!(await sessionSnapshot()).panes.some((pane) => pane.pane_id === paneId)) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
  const argv0 = (await processInfo(paneId))?.process_info?.foreground_processes?.[0]?.argv?.[0];
  return argv0 ? paneShell(argv0) : "unknown";
}
