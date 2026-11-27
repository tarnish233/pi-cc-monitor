#!/usr/bin/env python3
"""Example exit/status recorder. Invoke INSIDE a native runner, never via Monitor.

This is not a runner or daemon. It starts one foreground command, redirects its
real logs to a new stable run directory, and writes the pi-cc-job v1 contract.
No command arguments, environment values or credentials are stored in job.json.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import uuid


def now():
    return time.time_ns() // 1_000_000


def atomic_json(directory, name, value):
    fd, temp = tempfile.mkstemp(prefix=name + ".tmp-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, directory / name)
    finally:
        try:
            os.unlink(temp)
        except FileNotFoundError:
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runner", required=True, help="native runner name, informational only")
    parser.add_argument("--runner-id", required=True, help="native task/session/unit identifier")
    parser.add_argument("--job-id", help="stable display identifier, defaults to run-directory basename")
    parser.add_argument("--cancel-grace", type=float, default=30.0, help="seconds to let the command handle termination")
    parser.add_argument("run_directory")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or not 0 <= args.cancel_grace <= 3600:
        parser.error("provide one foreground command and a cancel grace between 0 and 3600 seconds")
    directory = Path(os.path.abspath(args.run_directory))
    job_id = args.job_id or directory.name
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", job_id):
        parser.error("job-id must be a 1–128 character identifier")
    for value in (args.runner, args.runner_id):
        if not value.strip() or len(value) > 500 or any(ord(c) < 32 or ord(c) == 127 for c in value):
            parser.error("runner metadata must be non-empty single-line text, at most 500 characters")
    directory.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive directory creation is the duplicate-run guard. Never reuse or
    # overwrite an existing run, even an empty directory or a stopped job.
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError:
        print("run directory already exists; choose a new directory/run instead of resubmitting", file=sys.stderr)
        return 2
    run_id = str(uuid.uuid4())
    created = now()
    manifest = {
        "schema": "pi-cc-job", "version": 1, "jobId": job_id,
        "runId": run_id, "createdAt": created,
        "runner": {"name": args.runner, "id": args.runner_id},
        "stdout": "stdout.log", "stderr": "stderr.log", "status": "status.json",
    }
    identity = {"schema": "pi-cc-job.status", "version": 1, "jobId": job_id, "runId": run_id}
    child = None
    cancellation = None
    cancelled_at = None
    termination_forwarded = False

    def publish_status(value):
        try:
            atomic_json(directory, "status.json", value)
            return True
        except OSError as error:
            # Recording is advisory after command launch. Do not orphan/stop the
            # real command or publish a false exit because the disk write failed.
            # Remove only our own prior status to make an unavailable report
            # observable as unknown, never touch logs/checkpoints/other runs.
            try:
                with open(directory / "status.json", encoding="utf-8") as source:
                    previous = json.loads(source.read(65537))
                if previous.get("jobId") == job_id and previous.get("runId") == run_id:
                    os.unlink(directory / "status.json")
            except (OSError, ValueError, AttributeError):
                pass
            try:
                print("status recording failed; query the native runner: " + str(error), file=sys.stderr)
            except OSError:
                pass
            return False

    def forward(signum, frame):
        nonlocal cancellation, cancelled_at, termination_forwarded
        if cancellation is None:
            cancellation = signum
            cancelled_at = time.monotonic()
        if child is not None and child.poll() is None:
            try:
                if os.name == "posix":
                    os.killpg(child.pid, signal.SIGTERM)
                else:
                    child.terminate()
                termination_forwarded = True
            except OSError:
                # The native runner remains the authority if signalling is denied.
                pass

    for sig in (signal.SIGTERM, signal.SIGINT, getattr(signal, "SIGHUP", signal.SIGTERM)):
        signal.signal(sig, forward)
    code = 127
    started = None
    exit_signal = None
    with open(directory / "stdout.log", "xb") as stdout, open(directory / "stderr.log", "xb") as stderr:
        os.chmod(directory / "stdout.log", 0o600)
        os.chmod(directory / "stderr.log", 0o600)
        atomic_json(directory, "job.json", manifest)
        atomic_json(directory, "status.json", {**identity, "state": "queued", "updatedAt": now()})
        try:
            if cancellation is None:
                child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                         start_new_session=os.name == "posix")
                started = now()
                # A signal may arrive during Popen before child is assigned.
                # Replay its TERM now without renewing the original grace deadline.
                if cancellation is not None and not termination_forwarded:
                    forward(cancellation, None)
                publish_status({**identity, "state": "running", "startedAt": started, "updatedAt": now()})
                while child.poll() is None:
                    if cancelled_at is not None and time.monotonic() - cancelled_at >= args.cancel_grace:
                        try:
                            if os.name == "posix":
                                os.killpg(child.pid, signal.SIGKILL)
                            else:
                                child.kill()
                        except OSError:
                            pass
                    time.sleep(0.05)
                code = child.wait()
            else:
                code = 128 + cancellation
        except OSError as error:
            stderr.write(("command could not start: " + str(error) + "\n").encode("utf-8"))
            code = 127
        finally:
            # Do not let a late signal touch a reaped/reused PID.
            child = None
        if code < 0:
            exit_signal = signal.Signals(-code).name
    ended = now()
    result = {**identity, "state": "cancelled" if cancellation is not None else "succeeded" if code == 0 else "failed",
              "updatedAt": ended, "endedAt": ended, "exitCode": None if code < 0 else code}
    if started is not None:
        result["startedAt"] = started
    if exit_signal is not None:
        result["signal"] = exit_signal
    publish_status(result)
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print("job recorder error: " + str(error), file=sys.stderr)
        sys.exit(2)
