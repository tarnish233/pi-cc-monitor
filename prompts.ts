/**
 * Model-facing text for the monitor tools.
 *
 * Selection rule (from Claude Code 2.1.318): one completion uses a background
 * command; repeated occurrences use the event stream. This extension combines
 * both into Monitor.mode; the default stays events for backward compatibility.
 * Keep the selection guidance concise and share deadlines with the runtime.
 */

export const MONITOR_TIMEOUTS = {
	events: { defaultMs: 300_000, maxMs: 3_600_000 },
	completion: { defaultMs: 1_800_000, maxMs: 7_200_000 },
	wait: { defaultMs: 1_800_000, maxMs: 7_200_000 },
} as const;

export const MONITOR_DESCRIPTION = `Run a background command, stream command/WebSocket events, or observe selected output from an existing command Monitor. Choose by notification shape:
- **One terminal result** → \`mode: "completion"\`. Use this for builds, tests, and commands that pend or wait for an external condition (for example, \`until grep -q "Ready in" dev.log; do sleep 0.5; done\`).
- **One notification per occurrence** → \`mode: "events"\` with \`tail -f\`, \`inotifywait -m\`, or a loop that prints one line per occurrence.
- **Selected output from running work** → start once with \`mode: "completion"\`, then attach an events observer using \`source: { monitorId }\` and optional literal \`watches\`. The observer owns no process; stopping, expiring or flooding it never stops the work. Omitted watches mean all stdout; \`watches: []\` mutes.
Omitted mode stays \`events\` for backward compatibility.

**completion**: use Monitor instead of foreground bash for long-running or externally gated commands. Start returns immediately; keep doing independent work. stdout and stderr are only written to log files. Unless collected with action=\"wait\", one result arrives after the active turn: exit 0 is "completed", nonzero exit or signal is "failed". If that turn is aborted, the result is stored without restarting it. A launch receipt is not completion; leaving a turn to wait is a progress handoff, not the final report. Do not poll, sleep, or re-read logs unless the user asks for progress or a line is needed to continue. Set \`timeout_ms\` to cover the expected runtime: default ${MONITOR_TIMEOUTS.completion.defaultMs}ms (30 minutes), max ${MONITOR_TIMEOUTS.completion.maxMs}ms (2 hours). \`persistent: true\` is only for intentional session-lifetime processes, not cross-process preservation.

**events**: Each stdout line is an event. stderr is logged but is not an event; merge it with \`2>&1\` only when running the source directly. Flush every pipe stage per line: grep needs --line-buffered, Python needs -u; head cannot. Do not run the real long-lived work here—use completion plus a source observer. \`ws\` streams text frames and represents binary frames with placeholders. Events may arrive while waiting for the user; an event is not their reply.

**notification policy**: \`notify.output\` is turn/context/none and \`notify.terminal\` is turn/context (defaults turn). A watch can lower, never raise, this ceiling. User stops never start a turn. Terminal outcomes use protected settled delivery; output budgets can suppress ordinary events while raw logs stay complete. A command events source whose output stays suppressed for 30 seconds is stopped.

**wait**: \`{action: "wait", ids, wait_timeout_ms?}\` joins only the specified command/completion tasks (1-20 distinct ids) at report closeout, not at launch. Continue independent work first; before a final report that depends on them, wait and read/verify the required outputs/files. Already-ended tasks return immediately; running finite tasks are awaited by Promise until termination and log finalization, not notification delivery. No polling, no sleep, no process is started/stopped and no policy/lifetime changes. Running persistent monitors, event commands, sockets and subscriptions are not wait targets. Returns per-task status, exit code, termination cause/signal and bounded execution errors, stdout/stderr tails (24 KiB combined across the batch) and full log paths. \`completed\` means all targets ended, not that all succeeded or their files were read; \`allSucceeded\` reports command success. \`wait_timeout_ms\` defaults to ${MONITOR_TIMEOUTS.wait.defaultMs}ms (30 minutes), max ${MONITOR_TIMEOUTS.wait.maxMs}ms (2 hours); it ends only the wait, leaving pending work running and returning \`completed: false\` / \`pendingIds\`. Cancellation ends only the wait. Collected terminal notices are deduplicated only when the complete emitted receipt or intact JSON result is present in persisted model-visible tool output. In codemode, use text(result) or return the complete wait result; nestedCalls=ok or a waitId alone is not delivery proof. Omitted, modified or truncated transfers retain protected terminal delivery. Do not declare an unresolved dependency complete.

**update**: \`{action: "update", id, watches?, notify?}\` changes only attached-observer watches and notification policy. It never starts/restarts work, changes source/lifetime, or resets unchanged rules. Use \`monitor_stop\` to end a subscription or the work itself; \`monitor_list\` shows status and counts.`;

export const MONITOR_PROMPT_GUIDELINES = [
	"For commands expected to run long, wait on an external condition or approach a foreground bash timeout, use Monitor with mode=\"completion\" instead of foreground bash. Use mode=\"events\" when each output line/frame should notify.",
	"After starting Monitor, continue independent work. Before a final report that depends on finite completion tasks, call Monitor with action=\"wait\" and the required ids, then read and verify the necessary outputs/files. A launch receipt is not completion.",
	"Do not poll or sleep while waiting for Monitor. If a wait returns completed=false or you leave a turn while dependencies are pending, give only a progress/explicitly incomplete update, not a completed final report. Unrelated background monitors need not be waited or stopped.",
	"Use a Monitor completion for long-lived work and an attached source observer for selected output; changing watches with action=update must not restart or stop the work.",
];

export const MONITOR_SNIPPET = "Run background commands, stream/observe events, or wait for specified completion tasks before final reporting";
export const MONITOR_STOP_SNIPPET = "Stop a running monitor or output subscription by id";
export const MONITOR_LIST_SNIPPET = "List monitors with their modes, status, event counts and exit codes";
