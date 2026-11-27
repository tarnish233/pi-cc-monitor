# Observation protocol v1

This working-tree API replaces Monitor's command executor. It is not a new runner.
All business background work must be submitted through a native external runner.
Monitor reads files/status or WebSocket messages and owns only its observation
resources and disposable copies. It never executes metadata or signals a job PID.

## Monitor inputs

```json
{"source":{"kind":"file","stdout":"runs/build/stdout.log","stderr":"runs/build/stderr.log"},"description":"build output","mode":"events"}
```

```json
{"source":{"kind":"job","manifest":"runs/train-01/job.json"},"description":"training result","persistent":true}
```

```json
{"source":{"kind":"job","host":"192.168.1.2","manifest":"/work/project/runs/train-01/job.json"},"description":"server training","mode":"completion"}
```

```json
{"source":{"kind":"ws","url":"wss://example.com/events","protocols":["events"]},"description":"event feed"}
```

- `file` requires at least one of `stdout` and `stderr`; the two paths must differ.
- `job` requires a readable, valid manifest at attachment time. Its log paths are
  optional, but its status path is required.
- `ws` accepts an ASCII ws/wss URL without userinfo or whitespace and optional
  unique RFC 6455 protocol tokens. Socket close is not a business-job result.
- `mode` defaults to `completion` for a job and `events` otherwise. Only a job
  source supports completion. A job can also use events to watch output and
  receive its terminal report. Watches apply directly to any events source.
- `from: "tail"` (default, file/job sources) replays at most the latest 64 KiB per
  source stream and then follows new bytes. `from: "now"` skips existing bytes.
  Observation copies are not guaranteed to contain the full original output.
  `now` skips the bytes that existed when the observation was armed; a log that
  did not exist yet is read from its start once it appears. Only a confirmed
  ENOENT establishes that absence; permission/transport failures that prevent a
  now baseline fail attachment explicitly instead of silently replaying old data.
- Polling is bounded but catch-up is not one chunk per poll: each stream may read
  up to 8 chunks (512 KiB, about 50 ms) per tick, and an unfinished stream is
  scheduled again after about 15 ms. Local ticks are 250 ms apart and remote ticks
  1000 ms apart. A finite burst is therefore copied in full unless a single
  backlog exceeds 8 MiB; only then does the reader resume from the retained tail,
  set `sourceGap` and publish one immediate context-level notice (at most one per
  30 s per observation). A terminal status first drains the remaining tail, so the
  terminal notice reports the end of the output. The time budget is checked
  between reads, not a per-read deadline: a slow read can exceed it. A pending
  tail relocation survives the yield and runs first on the next tick, even when
  SSH RTT exceeds 50 ms.
- Local paths resolve against Pi's cwd, with leading `@` and `~/` normalization.
  Remote input paths must be absolute POSIX paths. Manifest references resolve
  against the manifest directory, on the observed host, never Pi's cwd.
- `host` is one SSH destination (alias, hostname, IPv4/IPv6 address or user@host),
  including compressed IPv6 such as ::1 or user@::1, not a command, URI or option
  string. Existing SSH configuration handles ports/jumps.
- Remote observation requires Python 3 on a POSIX host. The transport supplies
  one fixed read-only helper; paths are JSON on stdin, never shell interpolation.
  It installs nothing and writes no remote files. EOF/connection loss ends the
  helper, with a 10-second idle lease and an 8-second per-read deadline.
- Reads are bounded and regular-file only. On platforms supporting O_NOFOLLOW,
  final-component symlinks are refused; devices/FIFOs are refused as sources.

The public API rejects `command`, top-level `ws`, and `source.monitorId`.
It does not silently convert old calls into runner submissions. `action:update`
accepts only `id`, `watches` and `notify`; no source/lifetime changes or restart.

## Job manifest

Create a new stable run directory for every attempt. Publish complete metadata
atomically; do not overwrite a previous run's identity or reuse its runId.

```json
{
  "schema": "pi-cc-job",
  "version": 1,
  "jobId": "train-01",
  "runId": "550e8400-e29b-41d4-a716-446655440000",
  "createdAt": 1700000000000,
  "runner": {"name": "tmux", "id": "train-01"},
  "stdout": "stdout.log",
  "stderr": "stderr.log",
  "status": "status.json"
}
```

`jobId` and `runId` are 1–128-character identifiers: letters, digits, dot,
underscore and hyphen, starting with a letter/digit. A display jobId may describe
an experiment; runId distinguishes its immutable attempt. `createdAt` is an
integer Unix millisecond timestamp. Runner name/id are non-empty single-line
strings, at most 500 characters; they are informational, not execution adapters.
Manifest/status/log paths must be distinct. Job references must remain inside the
manifest directory; parent links escaping that directory are rejected. Use an
explicit file source for intentionally observing other files. These checks are
not a sandbox against a hostile same-user filesystem race. Metadata is capped
at 64 KiB.

Unknown metadata is not executed and is not copied into model-visible snapshots.
Do not store startup commands, environment dumps or credentials in metadata.
If the manifest changes its recognized identity, runner or paths while observed,
Monitor reports unknown and refuses to adopt the replacement automatically.

## Status document

The runner-side recorder is the writer; Monitor is strictly a reader. Publish
updates with a same-directory temporary file and atomic rename.

```json
{
  "schema": "pi-cc-job.status",
  "version": 1,
  "jobId": "train-01",
  "runId": "550e8400-e29b-41d4-a716-446655440000",
  "state": "succeeded",
  "updatedAt": 1700000060000,
  "startedAt": 1700000001000,
  "endedAt": 1700000060000,
  "exitCode": 0
}
```

States: `queued`, `running`, `succeeded`, `failed`, `cancelled`.

- Job and run identifiers must match the attached manifest exactly.
- Timestamps are integer milliseconds with consistent created/start/end/update
  ordering. No file-value coercion is performed.
- Nonterminal states have no `endedAt`, exitCode or signal.
- Terminal states require endedAt and exitCode (`null` if unavailable).
- `succeeded` requires exitCode 0 and no terminating signal.
- `failed` requires a nonzero code, or null plus a `SIG...` signal name.
- `cancelled` means the external writer reports a confirmed cancellation/result,
  not merely that someone requested cancellation. Monitor never writes it.

Malformed, oversized, unreadable, stale-identity or missing status becomes
`job.state: "unknown"`, with a diagnostic. Monitor never interprets absent status,
log EOF, connection loss or its own timeout as task success/failure. A corrected
status for the original run can recover observation without resubmission.

A validated terminal file is the writer's report, **not an independent OS audit**.
Unexpected results should be checked against the native runner and required
outputs/checkpoints before the model claims success.

## Results and lifecycle

Tool receipts contain an observation `taskId`; it is not the runner's native ID.
`monitor_list` keeps observation `status` separate from nested `job.state` and
`job.exitCode`. An observation can be completed while the reported job failed.
No bare business PID/exitCode is conflated with an observation helper's result.

`monitor_stop` waits for local close: copy flush (up to about 2 s) and
confirmation of the owned helper group (about 1 s more), so a remote stop may
return after roughly 4 s. Unconfirmed cleanup reports `stopped: false` and keeps a
retryable record. A validated job terminal result still reaches the model
content alongside that cleanup diagnostic; it is not hidden in renderer-only
details or replaced by stop_timeout. Late release and explicit cleanup retries
do not publish the job fact again. A disposed runtime also releases its backstop
and owner marker when late I/O/close events finally confirm its resources gone,
without rearming polling or calling a stale Pi API.

`monitor_stop`, observation timeout, excessive-output stop, loop stop, Pi exit,
reload and session replacement close only observation resources. Business jobs
continue according to the runner's policy. Source problems are reported separately
from failures writing a disposable copy. Neither cancels business work.

Terminal reports retain safe response/tool-batch boundary delivery and Esc
protection. Start is an observation receipt, not proof that work completed. The
model must obtain and verify all required results before its final report.

There is no automatic task discovery, job restart or session restoration in this
step. Reconnect explicitly using the original manifest. Pi cannot send a model
notification while its process is not running.

## Storage and permissions

Runner scripts, manifest, status, business logs, checkpoints and formal outputs
belong in stable project storage, outside Monitor's private task directory. Monitor
GC never scans ordinary project run directories or remote runner storage.

Monitor outputPath/stderrPath are private, bounded observation copies. The default
20 MiB combined limit, two-segment rotation, retention/quota and 10-minute read
grace still apply. Read `.1` before current segments. `logTruncated` concerns lost
copy bytes; `sourceGap` concerns output not observed/replayed at all. Raw runner
logs require their own rotation/retention policy; Monitor's limits do not cap them.

Monitor is a real file/network reader, not a sandbox. Permission extensions must
cover Monitor's source paths and hosts, not only tool names `read` or `bash`.
The fixed helper and plain metadata must not be treated as user instructions.
