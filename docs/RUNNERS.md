# External runner examples

These are native CLI workflows, not tools or backend adapters implemented by
Monitor. User/project choice wins. Otherwise inspect the actual execution host,
prefer an available tmux for lightweight work, and ask if no suitable runner is
available. Never install/configure runners, enable linger, or request elevated
permissions implicitly. Avoid starting bare `&`/nohup work as a substitute for a
managed runner.

## Exit recorder example

`examples/job-wrapper.py` is an optional ordinary Python 3 script. Run it **inside**
the chosen runner. It records one foreground command's real output and exit result
in a new exclusive run directory using the observation v1 contract. It is not a
daemon, scheduler, runner selection layer or Monitor execution entry point.

Keep a project copy of the script in stable storage, not Monitor's private observation directory.
The script rejects an existing run directory, preventing accidental duplicate
submission/reuse. It does not store command arguments or environment values in
job.json. Choose a new run directory for an intentionally new attempt.

When TERM/INT/HUP reaches the recorder, it forwards TERM to its own command group,
allows a configurable grace (30 seconds by default), then kills that group if
necessary. A command must handle TERM itself to save a checkpoint; the recorder
cannot manufacture checkpoint support. A SIGKILL/crash of the recorder may leave
no terminal document: Monitor reports unknown, not an invented success/failure.

The example records the foreground command's exit, not an audit of arbitrary
daemonized grandchildren. Do not background/daemonize the actual command inside
it. Let the native runner own the business task and its cleanup policy.

## tmux: local builds or server training

Example paths below are placeholders. Quote real path/argument values correctly.
The wrapper creates the run directory; do not pre-create or reuse it.

```bash
tmux new-session -d -s train-01 -c /work/project \
  'exec python3 /work/project/job-wrapper.py --runner tmux --runner-id train-01 --job-id train-01 /work/project/runs/train-01 -- python3 -u train.py'
```

Create this session on the execution machine. If Pi runs locally but training runs
on the server, submit via the user's existing SSH configuration:

```bash
ssh 192.168.1.2 "tmux new-session -d -s train-01 -c /work/project 'exec python3 /work/project/job-wrapper.py --runner tmux --runner-id train-01 --job-id train-01 /work/project/runs/train-01 -- python3 -u train.py'"
```

The short submit command should return promptly. Confirm native session creation
and the complete manifest before attaching a job observation. Submission is not
training completion. Do not keep `tmux attach` as the Monitor command.

```json
{"source":{"kind":"job","host":"192.168.1.2","manifest":"/work/project/runs/train-01/job.json"},"description":"training result","persistent":true}
```

Native operations (outside Monitor):

```bash
tmux list-sessions
tmux attach-session -t train-01
# Only after an explicit request to cancel this training:
tmux kill-session -t train-01
```

Monitor stop ends only observation. It must never run the cancellation command.

## systemd: a transient user service on Linux

Use a service, not a terminal-bound scope. First verify that the user manager is
available and will stay alive after the submitting SSH/login session ends. Linger
may be needed on some hosts; changing that is an explicit user decision.

```bash
systemd-run --user --unit=train-01 --working-directory=/work/project \
  --property=TimeoutStopSec=45s \
  python3 /work/project/job-wrapper.py --runner systemd --runner-id train-01.service \
  --job-id train-01 /work/project/runs/train-01 -- python3 -u train.py
```

Query with `systemctl --user status train-01.service` and `journalctl --user -u
train-01.service`. Cancel only when requested with `systemctl --user stop
train-01.service`. The service's stop deadline should permit the command's
checkpoint/recorder grace. A host reboot is not training continuity; configure
checkpoint/resume separately, not automatic blind reruns.

## Slurm: use the existing scheduler

Submit a normal sbatch script. Example body:

```bash
#!/usr/bin/env bash
#SBATCH --job-name=train-01
set -e
cd /work/project
exec python3 /work/project/job-wrapper.py --runner slurm --runner-id "$SLURM_JOB_ID" \
  --job-id train-01 /work/project/runs/train-01 -- python3 -u train.py
```

Use `sbatch --parsable run.sh`, then `squeue`/`sacct` for native state. Only an
explicit cancellation request should use `scancel <job-id>`.

This example creates the manifest when the allocated worker starts. While it is
queued, use the existing scheduler's status interface; do not attach a job source
before its manifest exists. A scheduler-native recorder may publish a queued
manifest/status earlier using the same generic protocol. Monitor does not install
Slurm-specific status adapters or infer completion from log creation/EOF.

## Real logs and formal outputs

The example writes ordinary business logs. It does **not** bound their disk size.
Configure native journal limits, project log rotation/quotas, or an explicit
finished-log retention policy. Monitor only bounds its own observation copies.
Do not delete active logs, configuration, checkpoint or formal outputs merely to
satisfy a Monitor budget. Retention of business run scripts/records is a separate
project decision, never Monitor GC.
