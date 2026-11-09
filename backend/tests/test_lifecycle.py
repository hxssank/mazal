import os
import select
import signal
import subprocess
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from unittest.mock import patch

import pytest

from mazal_engine.lifecycle import _force_stop, monitor_parent


def test_standalone_engine_does_not_monitor_stdin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MAZAL_ENGINE_PARENT_PID", raising=False)
    monitor_parent()()


@pytest.mark.parametrize("parent", ["invalid", "0", "1", "-1"])
@pytest.mark.parametrize("platform", ["posix", "nt"])
def test_invalid_owner_rejects_startup(monkeypatch: pytest.MonkeyPatch, parent: str, platform: str) -> None:
    monkeypatch.setenv("MAZAL_ENGINE_PARENT_PID", parent)
    with patch("mazal_engine.lifecycle.os.name", platform):
        with pytest.raises(RuntimeError, match="owning Mazal server stopped"):
            monitor_parent()


def test_posix_rejects_owner_that_is_no_longer_the_parent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAZAL_ENGINE_PARENT_PID", "12345")
    with patch("mazal_engine.lifecycle.os.name", "posix"), \
            patch("mazal_engine.lifecycle.os.getppid", return_value=54321):
        with pytest.raises(RuntimeError, match="owning Mazal server stopped"):
            monitor_parent()


def test_windows_launcher_uses_owner_pipe_instead_of_direct_parent_pid(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAZAL_ENGINE_PARENT_PID", "12345")
    read_descriptor, write_descriptor = os.pipe()
    raw_read = os.read
    read_started = threading.Event()
    signalled = threading.Event()

    def read_pipe(_descriptor: int, count: int) -> bytes:
        read_started.set()
        return raw_read(read_descriptor, count)

    try:
        with patch("mazal_engine.lifecycle.os.name", "nt"), \
                patch("mazal_engine.lifecycle.os.getppid", return_value=54321), \
                patch("mazal_engine.lifecycle.os.read", side_effect=read_pipe), \
                patch("mazal_engine.lifecycle.signal.raise_signal", side_effect=lambda _value: signalled.set()) as raised, \
                patch("mazal_engine.lifecycle.threading.Timer") as timer:
            stop = monitor_parent()
            try:
                assert read_started.wait(2)
                assert not signalled.is_set()
                os.close(write_descriptor)
                write_descriptor = -1
                assert signalled.wait(2)
                raised.assert_called_once_with(signal.SIGTERM)
                assert timer.call_args.args[0] == 5
            finally:
                stop()
                if write_descriptor != -1:
                    os.close(write_descriptor)
                    write_descriptor = -1
                for thread in threading.enumerate():
                    if thread.name == "mazal-parent":
                        thread.join(2)
    finally:
        if write_descriptor != -1:
            os.close(write_descriptor)
        os.close(read_descriptor)


def test_owner_pipe_eof_requests_shutdown_and_installs_a_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAZAL_ENGINE_PARENT_PID", str(os.getppid()))
    monkeypatch.setattr("mazal_engine.lifecycle.os.read", lambda *_args: b"")
    signalled = threading.Event()
    signals = []
    deadlines = []

    def raise_signal(value: int) -> None:
        signals.append(value)
        signalled.set()

    class Deadline:
        def __init__(self, seconds: float, callback: Callable[[], None]) -> None:
            deadlines.append((seconds, callback))

        def start(self) -> None:
            pass

    monkeypatch.setattr("mazal_engine.lifecycle.signal.raise_signal", raise_signal)
    monkeypatch.setattr("mazal_engine.lifecycle.threading.Timer", Deadline)
    stop = monitor_parent()
    assert signalled.wait(2)
    stop()
    assert signals == [signal.SIGTERM]
    assert deadlines[0][0] == 5


def test_finished_lifespan_does_not_signal_when_pipe_closes_later(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAZAL_ENGINE_PARENT_PID", str(os.getppid()))
    read_started = threading.Event()
    release = threading.Event()
    signals = []

    def read(_descriptor: int, _count: int) -> bytes:
        read_started.set()
        release.wait(2)
        return b""

    monkeypatch.setattr("mazal_engine.lifecycle.os.read", read)
    monkeypatch.setattr("mazal_engine.lifecycle.signal.raise_signal", lambda value: signals.append(value))
    stop = monitor_parent()
    assert read_started.wait(2)
    stop()
    release.set()
    for thread in threading.enumerate():
        if thread.name == "mazal-parent":
            thread.join(2)
    assert signals == []


@pytest.mark.skipif(os.name != "posix", reason="Process-group shutdown is used on macOS and Linux.")
def test_unresponsive_engine_and_its_worker_stop_when_owner_pipe_closes() -> None:
    script = """
import signal, subprocess, sys, time
from mazal_engine.lifecycle import monitor_parent
signal.signal(signal.SIGTERM, signal.SIG_IGN)
worker = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
monitor_parent()
print(worker.pid, flush=True)
time.sleep(60)
"""
    process = subprocess.Popen(
        [sys.executable, "-c", script], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        start_new_session=True,
        env={**os.environ, "MAZAL_ENGINE_PARENT_PID": str(os.getpid()),
             "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
    )
    try:
        assert int(process.stdout.readline()) > 1
        process.stdin.close()
        assert process.wait(timeout=10) == -signal.SIGKILL
        # The worker inherits stdout. EOF proves it exited even while init has yet to reap its PID.
        ready, _, _ = select.select([process.stdout], [], [], 3)
        assert ready, "The calculation worker outlived its engine."
        assert process.stdout.read() == b""
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        process.stdout.close()


def test_windows_forced_shutdown_terminates_descendants() -> None:
    with patch("mazal_engine.lifecycle.os.name", "nt"), \
            patch("mazal_engine.lifecycle.subprocess.run") as run, \
            patch("mazal_engine.lifecycle.os._exit", side_effect=SystemExit):
        with pytest.raises(SystemExit):
            _force_stop()
        assert run.call_args.args[0] == ["taskkill", "/PID", str(os.getpid()), "/T", "/F"]
