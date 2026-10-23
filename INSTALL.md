# TermWeave installation

Use the reviewed local source instructions in [README](./README.md) and CONTRIBUTING. No curl|sh installer, automatic prerequisite upgrade, public exposure or upstream plugin replacement is supported. External access needs explicit opt-in and authentication. Windows and runtime bundle distribution remain unsupported.

## Starting and stopping an owned install

```
bun scripts/install-lifecycle.ts start --dir PATH [--port N]
bun scripts/install-lifecycle.ts stop  --dir PATH [--port N]
bun scripts/install-lifecycle.ts check --dir PATH
```

- `start` launches the server in the background and returns once it answers on `127.0.0.1`. If herdr is not running, the web server still starts and keeps running. `start` then reports `herdr is not ready` and exits 1. Start herdr and run `check`.
- `stop` stops the server gracefully. It uses the port recorded in `lifecycle.json`; `PORT` does not change it. If you pass a `--port` that differs from the recorded one, `stop` fails and sends nothing to either port.
- `stop` sends its request only after all of these checks pass:
  - The recorded server process is still the same process: same PID, start time and executable.
  - The bridge-only probe `/api/health?scope=bridge` on the recorded port answers with the recorded `boot_id`.
- herdr's state does not matter to `stop`. When the stop succeeds, the launcher removes `lifecycle.json` and exits. herdr and the browser are left running.
- Running `stop` again is safe. If nothing is running, it reports `not running` and exits 0. If an install or start is in progress, `stop` waits up to 10 s for it to finish.
- `check` exits 0 only when both are true:
  - this install's own server is running (process identity and bridge `boot_id` match);
  - the full `/api/health`, which includes herdr, is ok.
- The stop request is accepted only under these conditions:
  - It is a `POST` from this machine (loopback), and the `Host` header names the server's own port.
  - It carries no `Origin` or `Sec-Fetch-Site` header, so a browser cannot send it.
  - It carries the install instance's token in a header.
- The token is created for each launch. It is stored only in `lifecycle.json` inside the owned root, and the launcher passes it to the server through the environment, where the server deletes it at startup. It never appears in a URL, a command line, `server.log` or any output. Passing it through the environment does not hide it from an administrator of this machine.

### When stop fails

Nothing is ever killed automatically. A failed `stop` prints:

- the time of the check;
- the server's PID, start time and executable path;
- the launcher's PID and start time;
- the recorded port;
- the bridge probe result;
- guidance for the specific cause:
  - **The server accepted the stop but did not exit within 10 s.** It may still be finishing. Run `stop` again.
  - **The server process is alive but its port is silent** (hung or overloaded). The process is not killed and its state is not removed. Wait, then run `stop` again.
  - **Another boot id answers on the recorded port.** Another server holds the port, so no stop request was sent.

If you decide the server has to end now, use the PowerShell command that `stop` prints. Its form is:

```
$p=Get-CimInstance Win32_Process -Filter 'ProcessId=<pid>'; if($p -and $p.CreationDate -and $p.CreationDate.ToUniversalTime().ToString('o') -eq '<recorded start time>' -and $p.ExecutablePath -eq '<recorded exe>'){Stop-Process -Id <pid>}else{'Process <pid> changed or is gone: not stopped'}
```

Run it as printed. Just before stopping anything, it re-reads the process with CIM and compares the PID, CreationDate and executable path. If any of them changed, it stops nothing. Windows reuses PIDs, so never run `Stop-Process` with a remembered PID number alone. After the server ends, the launcher removes `lifecycle.json` by itself. Then run `check` to confirm the state.

### Leftover lifecycle guard

Lifecycle commands serialize on a guard file next to the install directory (`.termweave-<digest>.guard`). If a lifecycle process crashed while it held the guard, `stop` reports `the lifecycle guard is still held`. This is not a server stop timeout. The report shows the guard path and the recorded owner, and no request is sent.

The guard is never removed automatically: no age, TTL, `--force` or "owner is gone" rule does it. An owner that is gone does not by itself make removal safe. Remove the guard by hand only during an offline maintenance window:

1. End every TermWeave lifecycle command for this install directory, including waiters, `install`/`start`/`stop` runs and the background launcher.
2. Make sure no new one can start.
3. Delete only the guard file named in the report.
4. Leave the work lock (`.termweave-<digest>.lock`) and `lifecycle.json` in place. The next normal command judges them again.

If you cannot confirm that nothing runs for this install, do not delete the guard. Afterwards, run `check`.
