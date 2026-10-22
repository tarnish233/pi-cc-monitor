/**
 * Model-facing text for the monitor tools.
 *
 * The Monitor description follows Claude Code's (v2.1.302) almost line for
 * line. The differences are Pi's: monitor_stop / monitor_list instead of
 * TaskStop / TaskList, a foreground bash loop instead of `run_in_background`
 * for single notifications, and the limits this extension applies.
 */

export const MONITOR_DESCRIPTION = `Start a background monitor that streams events from a long-running script. Each stdout line is an event \u2014 you keep working and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user, even if one lands while you're waiting for the user to answer a question.

Pick by how many notifications you need:
- **One** ("tell me when the server is ready / the build finishes") \u2192 run the command in the **foreground with bash**, exiting when the condition is true, e.g. \`until grep -q "Ready in" dev.log; do sleep 0.5; done\`.
- **One per occurrence, indefinitely** ("tell me every time an ERROR line appears") \u2192 Monitor with an unbounded command (\`tail -f\`, \`inotifywait -m\`, \`while true\`).
- **One per occurrence, until a known end** ("emit each CI step result, stop when the run completes") \u2192 Monitor with a command that emits lines and then exits.

Your script's stdout is the event stream. Each line becomes a notification. Exit ends the watch.
  # Each matching log line is an event
  tail -f /var/log/app.log | grep --line-buffered "ERROR"
  # Each file change is an event
  inotifywait -m --format '%e %f' /watched/dir
  # Poll GitHub for new PR comments and emit one line per new comment
  last=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  while true; do
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    gh api "repos/owner/repo/issues/123/comments?since=$last" --jq '.[] | "\\(.user.login): \\(.body)"'
    last=$now; sleep 30
  done
  # Per-occurrence with a natural end: emit each CI check as it lands, exit when the run completes
  prev=""
  while true; do
    s=$(gh pr checks 123 --json name,bucket)
    cur=$(jq -r '.[] | select(.bucket!="pending") | "\\(.name): \\(.bucket)"' <<<"$s" | sort)
    comm -13 <(echo "$prev") <(echo "$cur")
    prev=$cur
    jq -e 'all(.bucket!="pending")' <<<"$s" >/dev/null && break
    sleep 30
  done

**Don't use an unbounded command for a single notification.** \`tail -f\`, \`inotifywait -m\`, and \`while true\` never exit on their own, so the monitor stays armed until its timeout even after the event has fired. Note that \`tail -f log | grep -m 1 ...\` does *not* fix this: if the log goes quiet after the match, \`tail\` never receives SIGPIPE and the pipeline hangs anyway.

**Script quality:**
- Every pipe stage must flush per line or matches sit in its buffer unseen: \`grep\` needs \`--line-buffered\`, \`awk\` needs \`fflush()\`, Python needs \`-u\`. \`head\` cannot flush at all \u2014 \`| head -N\` delivers nothing until N matches accumulate, then ends the stream.
- In poll loops, handle transient failures (\`curl ... || true\`) \u2014 one failed request shouldn't kill the monitor.
- Poll intervals: 30s+ for remote APIs (rate limits), 0.5-1s for local checks.
- Write a specific \`description\` \u2014 it appears in every notification ("errors in deploy.log" not "watching logs").
- Only stdout is the event stream. Stderr goes to the output file (readable with the read tool) but does not trigger notifications \u2014 for a command you run directly (e.g. \`python train.py 2>&1 | grep --line-buffered ...\`), merge stderr with \`2>&1\` so its failures reach your filter. (No effect on \`tail -f\` of an existing log \u2014 that file only contains what its writer redirected.)

**Coverage \u2014 silence is not success.** When watching a job or process for an outcome, your filter must match every terminal state, not just the happy path. A monitor that greps only for the success marker stays silent through a crashloop, a hung process, or an unexpected exit \u2014 and silence looks identical to "still running". Before arming, ask: *if this process crashed right now, would my filter emit anything?* If not, widen it.
  # Wrong \u2014 silent on crash, hang, or any non-success exit
  tail -f run.log | grep --line-buffered "elapsed_steps="
  # Right \u2014 one alternation covering progress and the failure signatures you'd act on
  tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|assert|Killed|OOM"
For poll loops checking job state, emit on every terminal status (\`succeeded|failed|cancelled|timeout\`), not just success. If you cannot confidently enumerate the failure signatures, broaden the alternation rather than narrow it \u2014 some extra noise is better than missing a crashloop.

**Output volume**: Every stdout line is a conversation message, so the filter should be selective \u2014 but selective means "the lines you'd act on", not "only good news". Never pipe raw logs. Stdout lines within 200ms are batched into a single notification; a line keeps at most 500 characters and a notification at most 3000. Notifications are rate-limited to a burst of 10, then one every 2 seconds: monitors that produce too many events are automatically stopped \u2014 restart with a tighter filter if this happens.

The script runs in the same shell environment as the bash tool. Exit ends the watch (the exit code is reported). Timeout \u2192 killed, and you get one notice with the event count; re-arm it if you still need the watch. Set \`persistent: true\` for session-length watches (PR monitoring, log tails) \u2014 the monitor then runs until you call monitor_stop or the session ends. Use monitor_stop to cancel early and monitor_list to see what is running.

**ws source** \u2014 open a WebSocket and stream each incoming text frame as an event. No shell, no polling: the server pushes, you get notified.
  Monitor({ ws: { url: 'wss://events.example.com/stream', protocols: ['v1'] }, description: 'deploy events' })
Each text frame becomes one notification. Binary frames are reported as \`[binary frame, N bytes]\` rather than passed through. Socket close ends the watch with the close code surfaced; errors are surfaced before close. Prefer this over \`command: 'websocat wss://\u2026'\` \u2014 it avoids the extra process and line-buffering pitfalls. Use a command when you need to filter frames with shell tools before they become events.`;

export const MONITOR_SNIPPET = "Watch a background command's stdout (or a WebSocket): each line wakes you as a notification";
export const MONITOR_STOP_SNIPPET = "Stop a running monitor by id";
export const MONITOR_LIST_SNIPPET = "List monitors with their status, event counts and exit codes";
