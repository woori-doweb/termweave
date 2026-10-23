/** Test support: the DACL Windows actually keeps on a file, read and changed with `icacls`, for owner-only assertions (server/private-file.ts). */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { currentUserSid } from "../scripts/owned-install.ts";

export interface Dacl { protected: boolean; aces: string[] }

/** icacls.exe from System32 by absolute path, bounded so a wedged ACL call fails the test instead of hanging it. */
function icacls(args: string[]): number | null {
  const root = process.env["SystemRoot"];
  if (!root || !isAbsolute(root)) throw new Error("SystemRoot is required to use icacls");
  const result = spawnSync(join(root, "System32", "icacls.exe"), args, { windowsHide: true, stdio: "ignore", timeout: 15_000 });
  return result.error ? null : result.status;
}

/** A file's DACL: whether inheritance is off (SDDL `P`) and its ACEs, `SY` spelled as its SID, sorted. */
export function fileDacl(path: string): Dacl {
  const scratch = mkdtempSync(join(tmpdir(), "tw-dacl-"));
  try {
    const saved = join(scratch, "acl");
    if (icacls([path, "/save", saved]) !== 0) throw new Error(`icacls /save failed for ${path}`);
    const sddl = readFileSync(saved).toString("utf16le").split(/\r?\n/)[1]?.trim() ?? "";
    const match = /^D:([A-Z]*)((?:\([^()]*\))*)$/.exec(sddl);
    if (!match) throw new Error(`Unexpected SDDL: ${sddl}`);
    const aces = match[2]!.slice(1, -1).split(")(").filter(Boolean).map((ace) => ace.split(";").map((part, index) => index === 5 && part === "SY" ? "S-1-5-18" : part).join(";"));
    return { protected: match[1]!.includes("P"), aces: aces.sort() };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Corrupts a file's DACL the way a careless tool would: Everyone (S-1-1-0) gets read access next to the owner-only ACEs. */
export function grantEveryoneRead(path: string): void {
  if (icacls([path, "/grant", "*S-1-1-0:R"]) !== 0) throw new Error(`icacls /grant failed for ${path}`);
}

/** What server/private-file.ts promises on Windows: inheritance off, full control for the current user and SYSTEM, nothing else. */
export const ownerOnlyDacl = (): Dacl => ({ protected: true, aces: [`A;;FA;;;${currentUserSid()}`, "A;;FA;;;S-1-5-18"].sort() });
