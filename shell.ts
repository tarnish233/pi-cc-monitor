/**
 * Shell configuration for monitor commands.
 *
 * Monitor commands run the way Pi's bash tool runs commands: in the shell from
 * Pi's `shellPath` setting, with `shellCommandPrefix` on its own line before
 * the command, and with Pi's own bin directory at the front of PATH.
 * `getShellConfig()` and `getAgentDir()` are exported from pi-coding-agent;
 * the environment helper is not, so it is rebuilt here from the same rule
 * (PATH gets `<agent dir>/bin`, Pi's `getBinDir()`).
 */

import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import path from "node:path";

/** Pi's shell settings, from the session's effective settings (`pi.getSettings()`). */
export interface ShellSettings {
	shellPath?: string;
	shellCommandPrefix?: string;
}

/**
 * The environment a monitor command runs in: the current environment with Pi's
 * bin directory prepended to PATH.
 */
export function monitorEnv(): NodeJS.ProcessEnv {
	const binDir = path.join(getAgentDir(), "bin");
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const current = process.env[pathKey] ?? "";
	const entries = current.split(path.delimiter).filter(Boolean);
	const updated = entries.includes(binDir) ? current : [binDir, ...entries].join(path.delimiter);
	return { ...process.env, [pathKey]: updated };
}

export interface MonitorShell {
	shell: string;
	args: string[];
	/** "argv" passes the command as an argument, "stdin" pipes it in. */
	commandTransport: "argv" | "stdin";
}

/** A leading `~` in `shellPath` is the home directory, as Pi documents for the setting. */
function expandHome(file: string): string {
	if (file === "~") return os.homedir();
	if (file.startsWith("~/") || (process.platform === "win32" && file.startsWith("~\\"))) {
		return path.join(os.homedir(), file.slice(2));
	}
	return file;
}

/** The shell Pi's bash tool would use; throws when `shellPath` does not exist or no shell is found. */
export function monitorShell(settings: ShellSettings = {}): MonitorShell {
	const config = getShellConfig(settings.shellPath ? expandHome(settings.shellPath) : undefined);
	return {
		shell: config.shell,
		args: config.args,
		commandTransport: config.commandTransport ?? "argv",
	};
}

/** The command as Pi's bash tool runs it: `shellCommandPrefix` on its own line first. */
export function prefixedCommand(command: string, settings: ShellSettings = {}): string {
	return settings.shellCommandPrefix ? `${settings.shellCommandPrefix}\n${command}` : command;
}
