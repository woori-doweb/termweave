/**
 * The original path of a file copied in Explorer and pasted into the app. A browser never
 * reveals where a pasted file lives, only its name, size and bytes, so the client would have
 * to upload a copy. The server runs on the PC whose clipboard holds Explorer's file drop list,
 * so it can read that list instead. It answers only with entries that match, by name and
 * on-disk size, files the browser already holds: the answer names nothing the page could not
 * already see, apart from where those files sit.
 */
import { stat } from "node:fs/promises";
import { basename, win32 } from "node:path";
import { MAX_INSERT_FILES } from "../shared/insert-files.ts";

export interface ClipboardFile { name: string; size: number }

const MAX_NAME_LENGTH = 255;

// Get-Clipboard -Format exists only in Windows PowerShell 5.1, not in pwsh 7.
const DROP_LIST_SCRIPT = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }";

/** The full paths Explorer put on this PC's clipboard, or nothing when it holds no files or cannot be read. */
export async function readFileDropList(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  try {
    const probe = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", DROP_LIST_SCRIPT], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000, killSignal: "SIGKILL" });
    const [code, out] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
    return code === 0 ? out.split(/\r?\n/).filter((line) => line !== "") : [];
  } catch { return []; }
}

/** A drop list entry's file name; a Windows path splits on backslashes even where the tests run on POSIX. */
function entryName(path: string): string {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") ? win32.basename(path) : basename(path);
}

/**
 * The clipboard path of each requested file, in the request's order, or null unless every one
 * matches a distinct drop list entry by name and size. The size is read asynchronously: an
 * entry on an unreachable network share can take seconds to answer.
 */
export async function clipboardFilePaths(
  files: readonly ClipboardFile[],
  read: () => Promise<string[]> = readFileDropList,
  sizeOf: (path: string) => Promise<number | undefined> = (path) => stat(path).then((stats) => stats.size, () => undefined),
): Promise<string[] | null> {
  const entries = await read();
  if (entries.length === 0) return null;
  const used = new Set<number>();
  const paths: string[] = [];
  for (const file of files) {
    const name = file.name.normalize("NFC");
    let index = -1;
    for (let at = 0; at < entries.length && index === -1; at++) {
      const entry = entries[at]!;
      if (!used.has(at) && entryName(entry).normalize("NFC") === name && await sizeOf(entry) === file.size) index = at;
    }
    if (index === -1) return null;
    used.add(index);
    paths.push(entries[index]!);
  }
  return paths;
}

/** The request body's files, or null when it is not `{ files: [{ name, size }] }` within the limits. */
export function validClipboardRequest(body: unknown): ClipboardFile[] | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const files = (body as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_INSERT_FILES) return null;
  const valid: ClipboardFile[] = [];
  for (const file of files) {
    if (file === null || typeof file !== "object") return null;
    const { name, size } = file as { name?: unknown; size?: unknown };
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
    valid.push({ name, size });
  }
  return valid;
}
