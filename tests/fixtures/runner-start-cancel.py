"""Inject TERM after command creation but before recorder.child assignment; POSIX, offline."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

wrapper, run, checkpoint, when = sys.argv[1:]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("recorder", wrapper)
recorder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recorder)
read_fd, write_fd = os.pipe()
real_popen = subprocess.Popen
real_now = recorder.now
real_killpg = os.killpg
launched = False
term_calls = 0


def signal_group(pid, signum):
    global term_calls
    if signum == signal.SIGTERM:
        term_calls += 1
    return real_killpg(pid, signum)


def started_now():
    global launched
    if launched and when == "after":
        launched = False
        signal.raise_signal(signal.SIGTERM)
    return real_now()


def launch_with_pending_term(command, **kwargs):
    global launched
    child = real_popen(command, pass_fds=(write_fd,), **kwargs)
    os.close(write_fd)
    assert os.read(read_fd, 1) == b"R", "command did not install its TERM handler"
    os.close(read_fd)
    if when == "before":
        signal.raise_signal(signal.SIGTERM)
    launched = True
    return child


subprocess.Popen = launch_with_pending_term
os.killpg = signal_group
recorder.now = started_now
command = """import os,signal,sys,time
from pathlib import Path
def checkpoint(*_):
    Path(sys.argv[2]).write_text('checkpoint saved')
    time.sleep(0.02)
    sys.exit(0)
signal.signal(signal.SIGTERM, checkpoint)
signal.alarm(5)
os.write(int(sys.argv[1]), b'R')
os.close(int(sys.argv[1]))
signal.pause()
"""
sys.argv = ["recorder", "--runner", "fixture", "--runner-id", "start-window", "--cancel-grace", "1", run,
            "--", sys.executable, "-c", command, str(write_fd), checkpoint]
code = recorder.main()
status = json.loads((Path(run) / "status.json").read_text())
print(json.dumps({"checkpointSaved": Path(checkpoint).exists(), "recorderExit": code, "state": status["state"], "signal": status.get("signal"), "termCalls": term_calls}), flush=True)
sys.exit(code)
