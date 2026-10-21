/**
 * Shell configuration for monitor commands.
 *
 * Pi's bash tool runs commands with the user's shell and an environment that
 * has Pi's own bin directory on PATH. `getShellConfig()` is exported from
 * pi-coding-agent; the matching environment helper is not, so it is rebuilt
 * here from the same rule.
 */

import { getShellConfig } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import path from "node:path";

/** The agent directory, matching pi's own resolution order. */
export function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR ?? process.env.TAU_CODING_AGENT_DIR;
	if (env) {
		return env === "~" ? path.join(os.homedir(), env.slice(1)) : env.replace(/^~(?=\/)/, os.homedir());
	}
	return path.join(os.homedir(), ".pi", "agent");
}

/**
 * The environment a monitor command runs in: the current environment with Pi's
 * bin directory prepended to PATH.
 */
export function monitorEnv(): NodeJS.ProcessEnv {
	const binDir = path.join(agentDir(), "bin");
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

export function monitorShell(): MonitorShell {
	const config = getShellConfig();
	return {
		shell: config.shell,
		args: config.args,
		commandTransport: config.commandTransport ?? "argv",
	};
}
