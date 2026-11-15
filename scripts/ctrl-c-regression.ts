/**
 * Ctrl+C typed through the terminal session (herdr's `terminal session control`, TermWeave's
 * Windows input path) stops the program running in a pane: `\x03` goes in as terminal.input, the
 * long command ends and the shell takes the next line. Needs a herdr binary; runs on the isolated
 * test herdr (test-herdr.ts), which on Windows is started with Ctrl+C taken, not ignored.
 */
import "./test-herdr.ts";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { herdrSocketPath, paneRead, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { TerminalSession } from "../server/herdr/terminal-session.ts";

const socket = process.env.HERDR_SOCKET;
if (!socket) throw new Error("ctrl-c-regression needs herdr: put it on PATH or set HERDR_WEB_HERDR_BIN");
const herdr = process.env.HERDR_WEB_HERDR_BIN || Bun.which("herdr");
if (!herdr) throw new Error("ctrl-c-regression needs herdr: put it on PATH or set HERDR_WEB_HERDR_BIN");

const windows = process.platform === "win32";
const nonce = randomUUID().slice(0, 8);

async function lines(pane: string): Promise<string[]> {
  const read = await paneRead({ paneId: pane, source: "recent", format: "text", lines: 80 }, socket);
  return read.text.split("\n").map((line) => line.trimEnd());
}

/** Polls the pane until `seen`; `again` (when given) runs every 2 s while it is not. */
async function until(pane: string, seen: (lines: string[]) => boolean, ms: number, label: string, again?: () => void): Promise<void> {
  const deadline = Date.now() + ms;
  let next = Date.now() + 2_000;
  for (;;) {
    const current = await lines(pane);
    if (seen(current)) return;
    if (again && Date.now() >= next) {
      again();
      next = Date.now() + 2_000;
    }
    if (Date.now() > deadline) {
      const tail = current.filter((line) => line.trim()).slice(-15).join("\n");
      throw new Error(`${label} within ${ms} ms; pane tail:\n${tail}`);
    }
    await Bun.sleep(100);
  }
}

const exactly = (text: string) => (current: string[]) => current.some((line) => line.trim() === text);

let workspace: string | undefined;
let session: TerminalSession | undefined;
try {
  const created = await workspaceCreate({ cwd: tmpdir(), label: "ctrl-c-regression" }, socket);
  workspace = created.workspace.workspace_id;
  const pane = (await sessionSnapshot(socket)).panes.find((candidate) => candidate.workspace_id === workspace);
  if (!pane) throw new Error(`workspace ${workspace} has no pane in the session snapshot`);
  // the shell has drawn its prompt
  await until(pane.pane_id, (current) => current.some((line) => line.trim()), 15_000, "the shell drew nothing");

  const control = new TerminalSession({
    command: herdr,
    terminal: pane.terminal_id,
    cols: 100,
    rows: 30,
    // as the server opens it (server/index.ts): herdr's CLI reads HERDR_SOCKET_PATH, not HERDR_SOCKET
    env: { HERDR_SOCKET_PATH: herdrSocketPath() },
    onData: () => {},
    onExit: () => {},
  });
  session = control;
  const started = await Promise.race([control.started, Bun.sleep(10_000).then(() => false)]);
  if (!started) throw new Error(`the terminal session sent no frame: ${control.stderr.trim() || "no stderr"}`);

  // the shell takes input through the session before anything is interrupted
  control.write(`echo READY-${nonce}\r`);
  await until(pane.pane_id, exactly(`READY-${nonce}`), 15_000, "the shell did not run a line typed through the terminal session");

  control.write(windows ? "ping -t 127.0.0.1\r" : "sleep 600\r");
  if (windows) await until(pane.pane_id, (current) => current.some((line) => line.includes("TTL=")), 10_000, "ping did not start");
  else await Bun.sleep(1_500);

  control.write("\x03");
  // The echo runs only once the long command is gone. Ctrl+C also drops input typed ahead (the
  // console's input buffer on Windows, the tty's queue on POSIX), so the line is typed again
  // until the shell runs it.
  const after = () => { control.write(`echo AFTER-${nonce}\r`); };
  after();
  await until(pane.pane_id, exactly(`AFTER-${nonce}`), 10_000, "Ctrl+C did not stop the running program", after);
  console.log(`PASS Ctrl+C typed through the terminal session stops a running program (${process.platform})`);
} finally {
  if (session) {
    session.kill();
    await Promise.race([session.exited, Bun.sleep(5_000)]);
  }
  if (workspace) await workspaceClose(workspace, socket).catch((error) => { if (error?.code !== "workspace_not_found") throw error; });
}
