/**
 * Updates for installs made by scripts/install.sh (TERMWEAVE_OWNED_LAUNCH=1). Those installs are
 * plain copies, not git checkouts, so the source updater (updater.ts) cannot serve them.
 *
 * check:   GitHub's latest Release of the public repo, every 6 hours and on request.
 * install: only on the user's button. The release tag is cloned over HTTPS, built by the same
 *          owned-install.ts into a sibling directory, then a detached helper stops this server,
 *          swaps the directories, starts the new one and rolls back if it does not answer.
 * State the user keeps (~/.config/termweave, herdr sessions) lives outside the install directory.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PRODUCT_VERSION } from "../shared/product.ts";
import type { UpdateCommand, UpdateStatus } from "../shared/update.ts";
import type { UpdateService } from "./update-api.ts";
import { runCommand } from "./updater.ts";

export const RELEASE_REPO = "VoidLight00/termweave";
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const CHECK_EVERY = 6 * 60 * 60_000;
/** what install.sh passes to the server; the restarted one gets the same, nothing more */
const ENV_KEYS = ["HOME", "PATH", "PORT", "HOST", "LANG", "USER", "SHELL", "XDG_CONFIG_HOME", "HERDR_SOCKET", "HERDR_WEB_TOKEN"];

/** true when tag vX.Y.Z is newer than version X.Y.Z */
export function isNewer(tag: string, version: string): boolean {
  const a = RELEASE_TAG.exec(tag), b = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
  return false;
}

export function ownedUpdater(root: string, fetcher: typeof fetch = fetch): UpdateService & { stop(): void } {
  let status: UpdateStatus = {
    managed: true, auto_update: false, phase: "idle", current_revision: null, latest_revision: null,
    current_version: PRODUCT_VERSION, latest_version: null, available: false, checked_at: null, blocked_reason: null, error: null,
  };
  const patch = (next: Partial<UpdateStatus>) => { status = { ...status, ...next }; };

  const check = async () => {
    patch({ phase: "checking", error: null });
    try {
      const response = await fetcher(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "termweave-updater" }, signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const tag = String(((await response.json()) as { tag_name?: unknown }).tag_name ?? "");
      if (!RELEASE_TAG.test(tag)) throw new Error("The latest release has no vX.Y.Z tag");
      patch({ phase: "idle", latest_version: tag.slice(1), available: isNewer(tag, PRODUCT_VERSION), checked_at: new Date().toISOString() });
    } catch (error) {
      patch({ phase: "error", error: `Update check failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const install = async () => {
    const version = status.latest_version;
    if (!version || !status.available) return;
    patch({ phase: "building", error: null });
    const stage = mkdtempSync(join(dirname(root), `.${basename(root)}-update-`));
    try {
      await runCommand(stage, ["git", "clone", "--quiet", "--depth", "1", "--branch", `v${version}`, `https://github.com/${RELEASE_REPO}.git`, "src"], undefined, 180_000);
      const cloned = (JSON.parse(readFileSync(join(stage, "src", "package.json"), "utf8")) as { version?: unknown }).version;
      if (cloned !== version) throw new Error(`Release v${version} contains version ${String(cloned)}`);
      // the same installer as install.sh: frozen lockfile, no install scripts, a fresh directory
      await runCommand(stage, [process.execPath, join(stage, "src", "scripts", "owned-install.ts"), join(stage, "next")], undefined, 600_000);
      // owned-server.ts checks the marker's root against its own path: record the final one
      const marker = join(stage, "next", ".termweave-owned.json");
      writeFileSync(marker, JSON.stringify({ ...JSON.parse(readFileSync(marker, "utf8")), root }), { mode: 0o600 });
      const launcher = (JSON.parse(readFileSync(join(root, "lifecycle.json"), "utf8")) as { launcher?: unknown }).launcher;
      if (typeof launcher !== "number") throw new Error("This install has no recorded launcher to restart");
      patch({ phase: "restarting" });
      const env = Object.fromEntries(ENV_KEYS.flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
      const helper = spawn("/bin/sh", [join(import.meta.dir, "owned-swap.sh"), root, join(stage, "next"), String(launcher), process.execPath, process.env["PORT"] ?? "7317", stage],
        { detached: true, stdio: "ignore", env });
      helper.unref();
    } catch (error) {
      rmSync(stage, { recursive: true, force: true });
      patch({ phase: "error", error: `Update failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const initial = setTimeout(() => void check(), 30_000);
  const timer = setInterval(() => void check(), CHECK_EVERY);
  return {
    status: () => status,
    request: (command: UpdateCommand) => { void (command === "install" ? install() : check()); },
    stop: () => { clearTimeout(initial); clearInterval(timer); },
  };
}
