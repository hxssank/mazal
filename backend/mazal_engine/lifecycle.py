from __future__ import annotations

import os
import signal
import subprocess
import threading
from collections.abc import Callable


def _force_stop() -> None:
    if os.name == "posix" and os.getpgrp() == os.getpid():
        os.killpg(os.getpgrp(), signal.SIGKILL)
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(os.getpid()), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
    os._exit(1)


def monitor_parent() -> Callable[[], None]:
    parent = os.environ.get("MAZAL_ENGINE_PARENT_PID")
    if parent is None:
        return lambda: None
    if not parent.isdecimal() or int(parent) <= 1 or (os.name != "nt" and int(parent) != os.getppid()):
        raise RuntimeError("The owning Mazal server stopped before the financial engine started.")
    stopped = threading.Event()

    def watch() -> None:
        try:
            # Node owns the write end. EOF also detects a forced exit without a PID-reuse race.
            while os.read(0, 1):
                pass
        except OSError:
            pass
        if stopped.is_set():
            return
        deadline = threading.Timer(5, _force_stop)
        deadline.daemon = True
        deadline.start()
        signal.raise_signal(signal.SIGTERM)

    threading.Thread(target=watch, name="mazal-parent", daemon=True).start()
    return stopped.set
