/**
 * Process handling for command monitors.
 *
 * A monitor runs detached so it gets its own process group. Stopping it must
 * take the whole group down, otherwise a script that backgrounds children
 * leaves orphans behind. This mirrors what Claude Code does when it kills a
 * monitor.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";

export interface SpawnOptions {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	shell: string;
	shellArgs: string[];
	/** "argv" runs `shell <args> <command>`, "stdin" pipes the command in. */
	commandTransport: "argv" | "stdin";
	stdoutPath: string;
	stderrPath: string;
	onStdout: (chunk: Buffer) => void;
	onStderr: (chunk: Buffer) => void;
	onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
	onError: (error: Error) => void;
}

/** How long a process group gets to exit politely before it is killed. */
const KILL_ESCALATION_MS = 2000;

export function spawnMonitor(options: SpawnOptions): ChildProcess {
	const stdoutStream = fs.createWriteStream(options.stdoutPath, { flags: "a" });
	const stderrStream = fs.createWriteStream(options.stderrPath, { flags: "a" });

	const useStdin = options.commandTransport === "stdin";
	const child = spawn(options.shell, useStdin ? options.shellArgs : [...options.shellArgs, options.command], {
		cwd: options.cwd,
		env: options.env,
		// detached gives the child its own process group, so the whole tree can
		// be signalled with a negative pid.
		detached: process.platform !== "win32",
		// stdout and stderr stay piped: the caller needs the stdout events, and
		// both streams are also copied to their output files.
		stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
		windowsHide: true,
	});

	if (useStdin) {
		child.stdin?.on("error", () => {});
		child.stdin?.end(options.command);
	}

	child.stdout?.pipe(stdoutStream);
	child.stderr?.pipe(stderrStream);
	child.stdout?.on("data", options.onStdout);
	child.stderr?.on("data", options.onStderr);
	child.on("error", (error) => options.onError(error));
	// "close" fires after the process exited *and* its stdio streams are closed.
	// "exit" can fire while stdout is still buffered, which would report the
	// end of the watch before the last lines were delivered.
	child.on("close", (code, signal) => {
		stdoutStream.end();
		stderrStream.end();
		options.onExit(code, signal);
	});

	return child;
}

/**
 * Kill an entire process tree.
 *
 * Because children are spawned detached, their pid is the process group id on
 * POSIX, so a negative pid signals the whole group, including children the
 * script put in the background. Used when a monitor is stopped, times out,
 * floods or the session shuts down. Escalates to SIGKILL if the group is still
 * alive shortly after SIGTERM.
 */
export function killTree(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
	if (!child || child.pid === undefined) return;
	const pid = child.pid;

	if (process.platform === "win32") {
		try {
			spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		} catch {
			try {
				child.kill(signal);
			} catch {
				// already gone
			}
		}
		return;
	}

	const signalGroup = (sig: NodeJS.Signals): void => {
		try {
			process.kill(-pid, sig);
		} catch {
			try {
				child.kill(sig);
			} catch {
				// already gone
			}
		}
	};

	signalGroup(signal);
	if (signal !== "SIGKILL") {
		const escalate = setTimeout(() => {
			try {
				process.kill(-pid, 0); // probe: still alive?
				signalGroup("SIGKILL");
			} catch {
				// gone
			}
		}, KILL_ESCALATION_MS);
		escalate.unref?.();
	}
}
